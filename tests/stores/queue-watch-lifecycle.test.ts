/**
 * agbossjs/agboss#91: what the child queue's watch does at each turn of its life that the other
 * watch tests leave unsaid, on the real server behind a black-hole proxy and a clock a test moves:
 * a start that gives up says what for; the wait for the ping's answer is ended when the start is
 * (and when the watch stops); a stream that fails is warned about with its reason and opened
 * again; the kill of the dropped stream's cursor is bounded by half the liveness bound and a
 * second, and its client is closed after; a start the stop overtakes closes what it made.
 */
import { LogLevel } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { seconds, type Milliseconds } from "@agboss/core/units";
import {
  Collection,
  Db,
  MongoClient,
  Timestamp,
  type ChangeStream,
  type ChangeStreamInsertDocument,
  type Document,
} from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../support/database.js";
import { CONNECTS, instances, watching } from "../support/silent-watch.js";

const database = testDatabase();
const LIVENESS_SECONDS = 10;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A virtual clock that keeps every sleep it is asked for. */
class RecordingClock extends VirtualClock {
  readonly sleeps: { readonly delay: Milliseconds; readonly signal: AbortSignal | undefined }[] =
    [];

  override sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    this.sleeps.push({ delay, signal });
    return super.sleep(delay, signal);
  }
}

async function setup() {
  const clock = new RecordingClock();
  return {
    clock,
    ...(await instances(database, cleanups, { clock, livenessSeconds: LIVENESS_SECONDS })),
  };
}

/**
 * The watch's own clients (one connection each) that `isOurs` takes: made, and closed. The clients
 * of a stream monitor their commands (their cursors' ids are read from the events), the one made
 * to kill a dropped stream's cursor does not.
 */
function trackClients(isOurs: (client: MongoClient) => boolean = () => true): {
  readonly made: Set<MongoClient>;
  readonly closed: Set<MongoClient>;
  /** The replies to the `aggregate`s of the monitored clients (a stream's own). */
  readonly aggregates: string[];
} {
  const made = new Set<MongoClient>();
  const closed = new Set<MongoClient>();
  const aggregates: string[] = [];
  const db = Object.getOwnPropertyDescriptor(MongoClient.prototype, "db")?.value as (
    this: MongoClient,
    ...args: unknown[]
  ) => ReturnType<MongoClient["db"]>;
  const close = Object.getOwnPropertyDescriptor(MongoClient.prototype, "close")?.value as (
    this: MongoClient,
  ) => Promise<void>;
  vi.spyOn(MongoClient.prototype, "db").mockImplementation(function (this: MongoClient, ...args) {
    if (this.options.maxPoolSize === 1 && isOurs(this)) made.add(this);
    if (this.options.maxPoolSize === 1 && this.options.monitorCommands && !made.has(this)) {
      this.on("commandSucceeded", (event) => {
        if (event.commandName === "aggregate") aggregates.push(event.commandName);
      });
    }
    return db.call(this, ...args);
  });
  vi.spyOn(MongoClient.prototype, "close").mockImplementation(function (this: MongoClient) {
    if (this.options.maxPoolSize === 1 && isOurs(this)) closed.add(this);
    return close.call(this);
  });
  return { made, closed, aggregates };
}

describe("agbossjs/agboss#91: a start", () => {
  it("that is not answered within the bound is refused, saying so", async () => {
    const { proxy, clock, watched } = await setup();
    proxy.swallowNew(true);

    const opening = watched
      .watchQueued(() => undefined)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await clock.advance(seconds(LIVENESS_SECONDS));

    expect(await opening).toMatchObject({ message: "the deployment did not answer in time" });
  });

  it("ends its wait for the answer when it has it: the sleep it made is aborted", async () => {
    const { clock, watched } = await setup();

    await watching(watched, cleanups);

    const waits = clock.sleeps.filter((sleep) => sleep.delay === seconds(LIVENESS_SECONDS));
    expect(waits).toHaveLength(1);
    expect(waits[0]?.signal?.aborted).toBe(true);
  });
});

/** A change as the driver hands it on: the watch reads none of it, only that one came. */
const CHANGE = { operationType: "insert" } as ChangeStreamInsertDocument;

describe("agbossjs/agboss#91: what the watch hears", () => {
  it("a change of the current stream wakes the claimers; one of a stream it dropped does not", async () => {
    const { clock, watched } = await setup();
    const streams: ChangeStream[] = [];
    const watchOf = Object.getOwnPropertyDescriptor(Collection.prototype, "watch")?.value as (
      this: Collection,
      ...args: Parameters<Collection["watch"]>
    ) => ChangeStream;
    vi.spyOn(Collection.prototype, "watch").mockImplementation(function (
      this: Collection,
      ...args
    ) {
      const stream = watchOf.call(this, ...args);
      streams.push(stream);
      return stream;
    });
    const watch = await watching(watched, cleanups);
    streams[0]?.emit("change", CHANGE);
    expect(watch.wakes()).toBe(1);

    // the first stream is dropped and the second is the current one: the catch-up wake is the second
    streams[0]?.emit("error", new Error("the cursor is dead"));
    await clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(streams).toHaveLength(2);
      expect(watch.wakes()).toBe(2);
    }, CONNECTS);

    streams[0]?.emit("change", CHANGE);
    expect(watch.wakes()).toBe(2);
    streams[1]?.emit("change", CHANGE);
    expect(watch.wakes()).toBe(3);
  }, 60_000);
});

describe("agbossjs/agboss#91: a stream that closes", () => {
  it("is warned about as lost, and the stream is opened again", async () => {
    const { clock, logger, watched } = await setup();
    const streams: ChangeStream[] = [];
    const watchOf = Object.getOwnPropertyDescriptor(Collection.prototype, "watch")?.value as (
      this: Collection,
      ...args: Parameters<Collection["watch"]>
    ) => ChangeStream;
    vi.spyOn(Collection.prototype, "watch").mockImplementation(function (
      this: Collection,
      ...args
    ) {
      const stream = watchOf.call(this, ...args);
      streams.push(stream);
      return stream;
    });
    const watch = await watching(watched, cleanups);

    streams[0]?.emit("close");

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      message: expect.stringContaining("(its change stream closed)"),
    });
    await clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(streams).toHaveLength(2);
      expect(watch.wakes()).toBe(1);
    }, CONNECTS);
  }, 60_000);
});

describe("agbossjs/agboss#91: a stream that fails", () => {
  it("is warned about with its reason, and the stream is opened again", async () => {
    const { clock, logger, watched } = await setup();
    const streams: ChangeStream[] = [];
    const watchOf = Object.getOwnPropertyDescriptor(Collection.prototype, "watch")?.value as (
      this: Collection,
      ...args: Parameters<Collection["watch"]>
    ) => ChangeStream;
    vi.spyOn(Collection.prototype, "watch").mockImplementation(function (
      this: Collection,
      ...args
    ) {
      const stream = watchOf.call(this, ...args);
      streams.push(stream);
      return stream;
    });
    const watch = await watching(watched, cleanups);

    streams[0]?.emit("error", new Error("the cursor is dead"));

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      level: LogLevel.Warn,
      code: "child-queue.watch-connection-lost",
      message: expect.stringContaining("(its change stream failed: the cursor is dead)"),
    });
    // the lost stream's liveness ping ends with it: its sleep is aborted
    const beats = clock.sleeps.filter((sleep) => sleep.delay === seconds(LIVENESS_SECONDS / 2));
    expect(beats.length).toBeGreaterThan(0);
    expect(beats[0]?.signal?.aborted).toBe(true);
    await clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(streams).toHaveLength(2);
      expect(watch.wakes()).toBe(1);
    }, CONNECTS);
  }, 60_000);
});

describe("agbossjs/agboss#91: the kill of a dropped stream's cursor", () => {
  it("is bounded by half the liveness bound and a second, and the client made for it is closed after", async () => {
    const { proxy, clock, watched } = await setup();
    const killers = trackClients((client) => !client.options.monitorCommands);
    const watch = await watching(watched, cleanups);
    // the stream's cursor is on the server, and its id told to the watch, before the network goes
    await vi.waitFor(() => {
      expect(killers.aggregates).toHaveLength(1);
    }, CONNECTS);
    const sleepsBefore = clock.sleeps.length;

    proxy.cut();
    await clock.advance(seconds(LIVENESS_SECONDS / 2));
    await clock.advance(seconds(LIVENESS_SECONDS / 2));
    await clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBe(1);
    }, CONNECTS);

    await vi.waitFor(() => {
      expect(clock.sleeps.slice(sleepsBefore).map((sleep) => sleep.delay)).toContain(
        seconds(LIVENESS_SECONDS / 2 + 1),
      );
    }, CONNECTS);
    // the dropped stream's own close is bounded by a second and what the server holds a getMore
    expect(clock.sleeps.slice(sleepsBefore).map((sleep) => sleep.delay)).toContain(
      seconds(1 + LIVENESS_SECONDS / 4),
    );
    // the client made to do it is closed once it has
    await vi.waitFor(() => {
      expect(killers.made.size).toBeGreaterThan(0);
      expect(killers.closed.size).toBe(killers.made.size);
    }, CONNECTS);
  }, 60_000);
});

describe("agbossjs/agboss#91: a stop that overtakes a start", () => {
  it("closes the stream the start made, and nothing wakes after", async () => {
    const { proxy, clock, logger, watched } = await setup();
    const clients = trackClients();
    const watch = await watching(watched, cleanups);
    // the ping of the second start is held until the test says
    let answer: (reply: { operationTime: Timestamp }) => void = () => undefined;
    const held = new Promise<{ operationTime: Timestamp }>((resolve) => {
      answer = resolve;
    });
    const commandOf = Object.getOwnPropertyDescriptor(Db.prototype, "command")?.value as (
      this: Db,
      ...args: Parameters<Db["command"]>
    ) => Promise<Document>;
    let holding = false;
    let pingHeld = false;
    vi.spyOn(Db.prototype, "command").mockImplementation(function (this: Db, ...args) {
      const [command] = args;
      if (holding && "ping" in command) {
        holding = false;
        pingHeld = true;
        return held;
      }
      return commandOf.call(this, ...args);
    });
    proxy.cut();
    await clock.advance(seconds(LIVENESS_SECONDS / 2));
    await clock.advance(seconds(LIVENESS_SECONDS / 2));
    expect(logger.entries).toHaveLength(1);
    // the stream is lost: the next ping is the start of the stream that replaces it
    holding = true;
    await clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(pingHeld).toBe(true);
    }, CONNECTS);

    // the answer comes, and the stop with it — read from the answer itself, so that it lands after
    // the start has the reply and before it goes on
    let closing: Promise<void> | undefined;
    answer({
      get operationTime() {
        closing = watch.close();
        return new Timestamp({ t: 1, i: 1 });
      },
    });
    await vi.waitFor(() => {
      expect(closing).toBeDefined();
    }, CONNECTS);
    await closing;

    // the reopen that the stop overtook wakes nobody: it opened nothing
    expect(watch.wakes()).toBe(0);
    await vi.waitFor(() => {
      expect(clients.made.size).toBe(clients.closed.size);
    }, CONNECTS);
  }, 60_000);
});
