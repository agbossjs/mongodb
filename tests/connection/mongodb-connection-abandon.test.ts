/**
 * agbossjs/agboss#954, #1432: `MongoConnection.onAbandon` — the stop's end passed with `onDestroy` still
 * running: the client's sockets are destroyed at once, synchronously, never waiting on the server.
 */
import { vi, describe, expect, it } from "vitest";
import { MongoConnection } from "../../src/index.js";

const UNREACHABLE = "mongodb://127.0.0.1:1/?replicaSet=rs0";

/** A connection that never connected, its client's `close` a spy and its internal topology a spy. */
function connectionWithTopology() {
  const connection = new MongoConnection({ url: UNREACHABLE });
  const close = vi
    .spyOn(connection.client, "close")
    .mockImplementation(() => new Promise(() => undefined));
  const destroy = vi.fn();
  Object.defineProperty(connection.client, "topology", {
    value: { close: destroy, s: { servers: new Map() } },
    configurable: true,
  });
  return { connection, close, destroy };
}

describe("MongoConnection.onAbandon", () => {
  it("destroys the topology's sockets before it returns, and lets the orderly close go on by itself", () => {
    const { connection, close, destroy } = connectionWithTopology();

    connection.onAbandon();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a topology that throws on close is no throw out of the hook (the driver's own close finishes what it can)", () => {
    const { connection, destroy } = connectionWithTopology();
    destroy.mockImplementation(() => {
      throw new Error("already closed");
    });

    expect(() => {
      connection.onAbandon();
    }).not.toThrow();
  });
});
