/**
 * agbossjs/agboss#954, #1213: `closeClientBounded` — the client's orderly close, bounded; its
 * sockets destroyed at once when calls wait on the server (a pool has a connection checked out),
 * else once the grace has passed on the clock and the close has not ended. The driver's topology is
 * internal and found by name: a client with a topology of another shape is closed in order only.
 */
import { VirtualClock } from "@agboss/core/testing";
import { seconds, type Milliseconds } from "@agboss/core/units";
import { MongoClient } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { CLOSE_GRACE, closeClientBounded } from "../../src/connection/close-bounded.js";

/** A clock that remembers the signal of every sleep it was given. */
class RecordingClock extends VirtualClock {
  readonly signals: (AbortSignal | undefined)[] = [];

  override sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    this.signals.push(signal);
    return super.sleep(delay, signal);
  }
}

const busy = (): unknown => ({ pool: { checkedOut: new Set(["connection"]) } });
const idle = (): unknown => ({ pool: { checkedOut: new Set() } });
const topologyOf = (...servers: unknown[]) => ({
  s: { servers: new Map(servers.map((server, index) => [`s${String(index)}`, server])) },
});

/** A client that was never connected, its `close` a spy and its internal `topology` as given. */
function clientWith(topology: unknown, close: () => Promise<void>) {
  const client = new MongoClient("mongodb://127.0.0.1:1");
  const closing = vi.spyOn(client, "close").mockImplementation(close);
  Object.defineProperty(client, "topology", { value: topology, configurable: true });
  return { client, closing };
}

const never = (): Promise<void> => new Promise(() => undefined);

/** A topology whose `close` is a spy. */
function closableTopology(...servers: unknown[]) {
  const close = vi.fn(function closeTopology(this: unknown, ...args: unknown[]) {
    return { self: this, args };
  });
  return { topology: { ...topologyOf(...servers), close }, close };
}

describe("closeClientBounded: an orderly close, then the sockets", () => {
  it("a close that ends in order drops nothing, with or without a clock", async () => {
    for (const clock of [new VirtualClock(), undefined]) {
      const { topology, close } = closableTopology(idle());
      const { client, closing } = clientWith(topology, () => Promise.resolve());

      await closeClientBounded(client, clock);

      expect(closing).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();
    }
  });

  it("a close that has not ended at the grace drops the sockets: not before it", async () => {
    const clock = new VirtualClock();
    const { topology, close } = closableTopology(idle());
    const { client, closing } = clientWith(topology, never);
    let isDone = false;
    const result = closeClientBounded(client, clock).then(() => {
      isDone = true;
    });

    await clock.advance("999ms");
    expect(close).not.toHaveBeenCalled();
    expect(isDone).toBe(false);
    await clock.advance("1ms");
    await result;

    expect(close).toHaveBeenCalledTimes(1);
    expect(closing).toHaveBeenCalledTimes(2);
  });

  it("the grace is the given one", async () => {
    const clock = new VirtualClock();
    const { topology, close } = closableTopology(idle());
    const { client } = clientWith(topology, never);
    const result = closeClientBounded(client, clock, seconds(3));

    await clock.advance(seconds(2));
    expect(close).not.toHaveBeenCalled();
    await clock.advance(seconds(1));
    await result;

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("calls in flight: the sockets go at once, before the grace, and the topology closes as the driver's own: its close, no arguments", async () => {
    const clock = new VirtualClock();
    const { topology, close } = closableTopology(idle(), busy());
    const { client, closing } = clientWith(topology, never);
    const result = closeClientBounded(client, clock);

    expect(close).toHaveBeenCalledTimes(1);
    expect(close.mock.contexts[0]).toBe(topology);
    expect(close.mock.calls[0]).toEqual([]);
    expect(closing).toHaveBeenCalledTimes(2);

    await clock.advance(CLOSE_GRACE);
    await result;
  });

  it("calls in flight on a server that answers: the sockets are dropped once, not again", async () => {
    const { topology, close } = closableTopology(busy());
    const { client } = clientWith(topology, () => Promise.resolve());

    await closeClientBounded(client, new VirtualClock());

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("without a clock a close that ends is no reason to drop the sockets", async () => {
    const { topology, close } = closableTopology(idle());
    const { client } = clientWith(topology, () => Promise.resolve());

    await closeClientBounded(client, undefined);

    expect(close).not.toHaveBeenCalled();
  });

  it("the wait for the grace is ended once the close has ended", async () => {
    const clock = new RecordingClock();
    const { client } = clientWith(topologyOf(idle()), () => Promise.resolve());

    await closeClientBounded(client, clock);

    expect(clock.signals[0]?.aborted).toBe(true);
  });

  it("the late failure of the sockets' close is dropped: nothing rejects unhandled", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const { client } = clientWith(topologyOf(busy()), () => Promise.reject(new Error("late")));

    await closeClientBounded(client, new VirtualClock());
    await new Promise((done) => setImmediate(done));
    process.off("unhandledRejection", onUnhandled);

    expect(seen).toEqual([]);
  });

  it("a topology whose close throws leaves the close to itself", async () => {
    const throwing = {
      ...topologyOf(busy()),
      close: () => {
        throw new Error("the driver changed");
      },
    };
    const { client } = clientWith(throwing, () => Promise.resolve());

    await expect(closeClientBounded(client, new VirtualClock())).resolves.toBeUndefined();
  });
});

describe("closeClientBounded: a driver whose internals are not as found is left to its own close", () => {
  const SHAPES: readonly (readonly [string, unknown])[] = [
    ["no topology", undefined],
    ["a null topology", null],
    ["a topology that is no object", "topology"],
    ["a topology with no state", {}],
    ["a null state", { s: null }],
    ["a state that is no object", { s: "state" }],
    ["a state with no servers", { s: {} }],
    ["servers that are no Map", { s: { servers: { x: busy() } } }],
    ["servers that are an array", { s: { servers: [busy()] } }],
    ["no servers", topologyOf()],
    ["a server with no connection out", topologyOf(idle())],
    ["a null server", topologyOf(null)],
    ["a server that is no object", topologyOf("server")],
    ["a server with no pool", topologyOf({})],
    ["a null pool", topologyOf({ pool: null })],
    ["a pool that is no object", topologyOf({ pool: 3 })],
    ["a pool with no checkedOut", topologyOf({ pool: {} })],
    ["a checkedOut that is no Set", topologyOf({ pool: { checkedOut: { size: 3 } } })],
    ["a checkedOut that is an array", topologyOf({ pool: { checkedOut: ["connection"] } })],
  ];

  it.each(SHAPES)(
    "%s: no call in flight, so no sockets dropped before the grace",
    async (_name, topology) => {
      const clock = new VirtualClock();
      const { client, closing } = clientWith(topology, never);
      const result = closeClientBounded(client, clock);

      await clock.advance("999ms");
      expect(closing).toHaveBeenCalledTimes(1);
      await clock.advance("1ms");
      await result;
    },
  );

  it("a server that is no object, a null one and one with no pool are skipped, the busy one after them counts", async () => {
    const { topology, close } = closableTopology(
      null,
      "server",
      {},
      { pool: null },
      { pool: 3 },
      { pool: {} },
      { pool: { checkedOut: { size: 3 } } },
      { pool: { checkedOut: new Set() } },
      busy(),
    );
    const { client } = clientWith(topology, never);
    const clock = new VirtualClock();
    const result = closeClientBounded(client, clock);

    expect(close).toHaveBeenCalledTimes(1);

    await clock.advance(CLOSE_GRACE);
    await result;
  });
});
