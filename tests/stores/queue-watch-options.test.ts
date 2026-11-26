/**
 * agbossjs/agboss#81: the options of the child queue's change stream that no mutant of Stryker
 * drops (it empties a whole literal, never removes one key), each proved by a test that fails
 * without it, on the watch's own client (the commands it sends, as its events tell them): the
 * server holds each `getMore` for a quarter of the liveness bound, and the stream starts just
 * after the time of the ping sent before `open` resolved — never at the server's now, which a
 * child queued in between would be missed by.
 */
import { VirtualClock } from "@agboss/core/testing";
import {
  Db,
  MongoClient,
  Timestamp,
  type CommandStartedEvent,
  type CommandSucceededEvent,
  type Document,
} from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MongoChildExecutionQueueRepository, MongoConnection } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { testDatabase } from "../support/database.js";
import { RecordingLogger } from "../support/recording-logger.js";
import { REPLICA_SET_URL } from "../support/server.js";
import { urlOnDatabase } from "../support/database.js";

const database = testDatabase();
const Reply = z.object({ operationTime: z.instanceof(Timestamp) });
const LIVENESS_SECONDS = 8;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** What the watch's own clients (one connection each) are sent and answered. */
function trackWatchClients(): {
  readonly started: CommandStartedEvent[];
  readonly pings: Timestamp[];
} {
  const started: CommandStartedEvent[] = [];
  const pings: Timestamp[] = [];
  const original = Object.getOwnPropertyDescriptor(MongoClient.prototype, "db")?.value as (
    this: MongoClient,
    ...args: unknown[]
  ) => ReturnType<MongoClient["db"]>;
  const seen = new WeakSet<MongoClient>();
  vi.spyOn(MongoClient.prototype, "db").mockImplementation(function (this: MongoClient, ...args) {
    if (this.options.maxPoolSize === 1 && !seen.has(this)) {
      seen.add(this);
      this.on("commandStarted", (event: CommandStartedEvent) => started.push(event));
      this.on("commandSucceeded", (event: CommandSucceededEvent) => {
        const reply = Reply.safeParse(event.commandName === "ping" ? event.reply : undefined);
        if (reply.success) pings.push(reply.data.operationTime);
      });
    }
    return original.call(this, ...args);
  });
  return { started, pings };
}

async function watchOpen(): Promise<void> {
  const url = urlOnDatabase(REPLICA_SET_URL, database.name());
  const connection = new MongoConnection({ url, watchLivenessSeconds: LIVENESS_SECONDS });
  cleanups.push(() => connection.onDestroy());
  const queue = new MongoChildExecutionQueueRepository(
    connection,
    new VirtualClock(),
    new TestApplicationContext("instance-1"),
    new RecordingLogger(),
  );
  const watch = await queue.watchQueued(() => undefined);
  cleanups.push(() => watch.close());
}

describe("agbossjs/agboss#81: the options of the child queue's change stream", () => {
  it("a ping that tells no cluster time starts the stream with none named", async () => {
    const { started } = trackWatchClients();
    const commandOf = Object.getOwnPropertyDescriptor(Db.prototype, "command")?.value as (
      this: Db,
      ...args: Parameters<Db["command"]>
    ) => Promise<Document>;
    vi.spyOn(Db.prototype, "command").mockImplementation(function (this: Db, ...args) {
      return "ping" in args[0] && this.client.options.maxPoolSize === 1
        ? Promise.resolve({ ok: 1 })
        : commandOf.call(this, ...args);
    });

    await watchOpen();

    await vi.waitFor(
      () => {
        expect(started.some((event) => event.commandName === "aggregate")).toBe(true);
      },
      { timeout: 20_000 },
    );
    const stage = started.find((event) => event.commandName === "aggregate")?.command.pipeline[0];
    expect(Object.keys(stage?.$changeStream ?? {})).not.toContain("startAtOperationTime");
  });

  it("the server holds a getMore for a quarter of the liveness bound", async () => {
    const { started } = trackWatchClients();

    await watchOpen();

    await vi.waitFor(
      () => {
        const getMore = started.find((event) => event.commandName === "getMore");
        expect(getMore?.command.maxTimeMS).toBe((LIVENESS_SECONDS / 4) * 1000);
      },
      { timeout: 20_000 },
    );
  });

  it("the stream starts at the first cluster time after the ping's, not at the server's now", async () => {
    const { started, pings } = trackWatchClients();

    await watchOpen();

    // the driver sends the stream's `aggregate` once the stream is read, a turn after `open`
    await vi.waitFor(
      () => {
        expect(started.some((event) => event.commandName === "aggregate")).toBe(true);
      },
      { timeout: 20_000 },
    );
    const stage = started.find((event) => event.commandName === "aggregate")?.command.pipeline[0];
    const startAt: unknown = stage?.$changeStream?.startAtOperationTime;
    expect(startAt).toBeInstanceOf(Timestamp);
    const ping = pings[0];
    expect(ping).toBeInstanceOf(Timestamp);
    if (!(startAt instanceof Timestamp) || ping === undefined) return;
    expect([startAt.t, startAt.i]).toEqual([ping.t, ping.i + 1]);
  });
});
