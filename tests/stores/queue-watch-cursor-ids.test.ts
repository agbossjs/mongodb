/**
 * agbossjs/agboss#1169: the cursor id of an `aggregate` / `getMore` reply is not always a `Long`:
 * a `number` when it fits in 53 bits (`promoteLongs`, the default: about one id in 500), a `bigint`
 * with `useBigInt64=true` in the URL. The listener runs inside the driver's `emit`, on the command's
 * path: it records every shape as one `bigint`, the kill by id sends it as an int64, and it never
 * throws, whatever the reply holds; a watch that fails to start leaves no listener behind, and a
 * kill reaches only the queue collection of its own database. No server: the client is an emitter.
 */
import { Long, MongoClient, type CommandSucceededEvent } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { Clock } from "@agboss/core";
import { MongoConnection } from "../../src/index.js";
import { MongoQueueWatch } from "../../src/stores/queue-watch.js";
import { Collections } from "../../src/connection/collections.js";
import { cursorIdOf, killDropped, listenForCursors } from "../../src/stores/queue-watch-cursors.js";

/** A clock whose sleeps end at once: the deployment is "silent" as soon as the watch looks. */
class ImmediateClock extends Clock {
  now(): Date {
    return new Date(0);
  }

  sleep(): Promise<void> {
    return Promise.resolve();
  }
}

/** A clock whose sleeps never end: the kill answers first. */
class HungClock extends Clock {
  now(): Date {
    return new Date(0);
  }

  sleep(): Promise<void> {
    return new Promise(() => undefined);
  }
}

const NS = `app.${Collections.ChildExecutionQueue}`;

/** A client of command events only; `emit` takes any event, as the driver's reply may hold anything. */
class FakeClient {
  readonly #listeners = new Set<(event: CommandSucceededEvent) => void>();

  on(_event: "commandSucceeded", listener: (event: CommandSucceededEvent) => void): this {
    this.#listeners.add(listener);
    return this;
  }

  off(_event: "commandSucceeded", listener: (event: CommandSucceededEvent) => void): this {
    this.#listeners.delete(listener);
    return this;
  }

  emit(_event: "commandSucceeded", event: unknown): void {
    for (const listener of this.#listeners) listener(event as CommandSucceededEvent);
  }
}

const clientOf = (): FakeClient => new FakeClient();

const reply = (commandName: string, cursor: unknown): unknown => ({
  commandName,
  reply: { cursor },
});

describe("agbossjs/agboss#1169: a cursor id is a Long, a number or a bigint", () => {
  it.each([
    ["Long", Long.fromNumber(7), 7n],
    ["number", 7, 7n],
    ["bigint", 7n, 7n],
    ["Long over 53 bits", Long.fromString("9007199254740993"), 9007199254740993n],
    ["bigint over 53 bits", 9007199254740993n, 9007199254740993n],
  ])("a %s is recorded as the same bigint, once", (_shape, id, expected) => {
    const client = clientOf();
    const { cursors } = listenForCursors(client);
    client.emit("commandSucceeded", reply("aggregate", { id, ns: NS }));
    client.emit("commandSucceeded", reply("getMore", { id, ns: NS }));
    expect(cursors).toEqual([{ id: expected, ns: NS }]);
  });

  it("the same id in two shapes is one cursor", () => {
    const client = clientOf();
    const { cursors } = listenForCursors(client);
    client.emit("commandSucceeded", reply("aggregate", { id: Long.fromNumber(42), ns: NS }));
    client.emit("commandSucceeded", reply("getMore", { id: 42, ns: NS }));
    client.emit("commandSucceeded", reply("getMore", { id: 42n, ns: NS }));
    expect(cursors).toEqual([{ id: 42n, ns: NS }]);
  });

  it.each([
    ["Long", Long.ZERO],
    ["number", 0],
    ["bigint", 0n],
  ])("a closed cursor (id 0 as a %s) is not recorded", (_shape, id) => {
    const client = clientOf();
    const { cursors } = listenForCursors(client);
    client.emit("commandSucceeded", reply("getMore", { id, ns: NS }));
    expect(cursors).toEqual([]);
  });

  it("another command, and a reply without a usable cursor, are not recorded", () => {
    const client = clientOf();
    const { cursors } = listenForCursors(client);
    client.emit("commandSucceeded", reply("find", { id: 5n, ns: NS }));
    client.emit("commandSucceeded", reply("aggregate", { id: 5n }));
    client.emit("commandSucceeded", reply("aggregate", { id: "5", ns: NS }));
    client.emit("commandSucceeded", reply("aggregate", { id: 1.5, ns: NS }));
    client.emit("commandSucceeded", reply("aggregate", { id: Number.NaN, ns: NS }));
    client.emit("commandSucceeded", reply("aggregate", { id: 5n, ns: 7 }));
    client.emit("commandSucceeded", reply("aggregate", undefined));
    client.emit("commandSucceeded", { commandName: "aggregate", reply: undefined });
    client.emit("commandSucceeded", { commandName: "aggregate", reply: null });
    expect(cursors).toEqual([]);
  });

  it("never throws, whatever the reply holds; a reply it cannot read is warned about once, without its content", () => {
    const client = clientOf();
    const warn = vi.fn();
    const { cursors } = listenForCursors(client, warn);
    const hostile = {
      commandName: "aggregate",
      get reply(): never {
        throw new TypeError("secret document text");
      },
    };
    expect(() => {
      client.emit("commandSucceeded", hostile);
      client.emit("commandSucceeded", hostile);
      client.emit("commandSucceeded", {
        commandName: "getMore",
        reply: {
          cursor: {
            get id(): never {
              throw new RangeError("secret");
            },
            ns: NS,
          },
        },
      });
    }).not.toThrow();
    client.emit("commandSucceeded", reply("aggregate", { id: 9n, ns: NS }));
    expect(cursors).toEqual([{ id: 9n, ns: NS }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("secret");
  });

  it("unlisten ends it", () => {
    const client = clientOf();
    const { cursors, unlisten } = listenForCursors(client);
    unlisten();
    client.emit("commandSucceeded", reply("aggregate", { id: 3, ns: NS }));
    expect(cursors).toEqual([]);
  });

  it("cursorIdOf: integers of every shape, nothing else", () => {
    expect(cursorIdOf(Long.fromNumber(-1))).toBe(-1n);
    expect(cursorIdOf(5)).toBe(5n);
    expect(cursorIdOf(2n ** 62n)).toBe(2n ** 62n);
    for (const bad of [undefined, null, "5", 1.5, Number.NaN, 2 ** 60, {}, [5]])
      expect(cursorIdOf(bad)).toBeUndefined();
  });
});

describe("agbossjs/agboss#1169: the kill by id sends every shape as an int64", () => {
  it.each([
    ["Long", Long.fromNumber(7)],
    ["number", 7],
    ["bigint", 7n],
  ])("a cursor heard as a %s is killed as the Long 7", async (_shape, id) => {
    const client = clientOf();
    const { cursors } = listenForCursors(client);
    client.emit("commandSucceeded", reply("aggregate", { id, ns: NS }));
    const command = vi.fn().mockResolvedValue({});
    const db = { databaseName: "app", command };
    const orphans = cursors.map((cursor) => ({ ...cursor, generation: 1 }));
    await killDropped(db, orphans, 2, new HungClock(), vi.fn());
    expect(command).toHaveBeenCalledTimes(1);
    const sent = command.mock.calls[0]?.[0] as { cursors: unknown[] };
    expect(sent.cursors).toHaveLength(1);
    expect(Long.isLong(sent.cursors[0])).toBe(true);
    expect(String(sent.cursors[0])).toBe("7");
  });
});

describe("agbossjs/agboss#1169: the kill touches only the queue collection of its own database", () => {
  it("a cursor of another collection or another database, on the same client, is never killed", async () => {
    const client = clientOf();
    const { cursors } = listenForCursors(client);
    client.emit("commandSucceeded", reply("aggregate", { id: 1n, ns: "app.other_collection" }));
    client.emit(
      "commandSucceeded",
      reply("getMore", { id: 2n, ns: `other.${Collections.ChildExecutionQueue}` }),
    );
    client.emit("commandSucceeded", reply("aggregate", { id: 3n, ns: NS }));
    expect(cursors.map((cursor) => cursor.id)).toEqual([1n, 2n, 3n]);

    const command = vi.fn().mockResolvedValue({});
    const db = { databaseName: "app", command };
    const orphans = cursors.map((cursor) => ({ ...cursor, generation: 1 }));
    await killDropped(db, orphans, 2, new HungClock(), vi.fn());
    expect(command).toHaveBeenCalledTimes(1);
    const sent = command.mock.calls[0]?.[0] as { cursors: unknown[] };
    expect(sent.cursors.map(String)).toEqual(["3"]);
  });

  it("nothing of its own to kill: no command at all", async () => {
    const command = vi.fn().mockResolvedValue({});
    const db = { databaseName: "app", command };
    await killDropped(
      db,
      [{ id: 1n, ns: "app.other_collection", generation: 1 }],
      2,
      new HungClock(),
      vi.fn(),
    );
    expect(command).not.toHaveBeenCalled();
  });
});

describe("agbossjs/agboss#1169: a watch that fails to start leaves no listener behind", () => {
  it("the command listener it added to its client is removed again", async () => {
    // spies on the prototype, read per client (`contexts`): a late close of another test's client is not this one's
    const on = vi.spyOn(MongoClient.prototype, "on");
    const off = vi.spyOn(MongoClient.prototype, "off");
    try {
      const connection = new MongoConnection({
        url: "mongodb://127.0.0.1:1/app?directConnection=true",
        watchLivenessSeconds: 2,
      });
      await expect(
        MongoQueueWatch.open(connection, new ImmediateClock(), vi.fn(), vi.fn()),
      ).rejects.toThrow();
      const heard = (spy: typeof on): unknown[][] =>
        spy.mock.calls
          .map((call, index) => [spy.mock.contexts[index], call[1]])
          .filter((_pair, index) => spy.mock.calls[index]?.[0] === "commandSucceeded");
      expect(heard(on)).toHaveLength(1);
      expect(heard(off)).toEqual(heard(on));
    } finally {
      on.mockRestore();
      off.mockRestore();
    }
  });
});
