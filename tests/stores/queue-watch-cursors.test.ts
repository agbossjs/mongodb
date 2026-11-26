/**
 * agbossjs/agboss#1088: the queue watch leaves no change-stream cursor of its own on the server.
 * The cursors are counted on every member of the real replica set (`$currentOp` with idle
 * cursors), on the test database, as the difference from what was there before the test. A watch
 * that is closed must close its stream first and its client after: the client's one connection
 * carries the stream's `killCursors`, and the client's close shuts it. A watch reopened after the
 * black hole must kill the dropped stream's cursor by id. Real clock. The black hole is on the change stream's connection only; new connections go through.
 * A stream dropped as dead cannot tell the server to drop its cursor (its one connection is the
 * dead one), so the watch kills it by id over a short-lived client made for the kill; a server that cannot be
 * reached then keeps the cursor until `cursorTimeoutMillis` (10 min), which no test can check.
 */
import { seconds } from "@agboss/core/units";
import { MongoClient } from "mongodb";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { MongoChildExecutionQueueRepository, MongoConnection } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { testDatabase } from "../support/database.js";
import { RealClock, sleep } from "../support/pause.js";
import { RecordingLogger } from "../support/recording-logger.js";
import { REPLICA_SET_URL } from "../support/server.js";
import { changeStreamCursors, closeCursorProbes } from "../support/server-cursors.js";
import { connectionTo } from "../support/stores.js";
import { CONNECTS, child, instances, watching } from "../support/silent-watch.js";
import { holdFailPoints } from "../support/failpoint-lock.js";

const database = testDatabase();
const cleanups: (() => Promise<void>)[] = [];

afterAll(closeCursorProbes);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The database's change-stream cursors that were not there at `before`. */
const newSince = async (before: readonly string[]): Promise<string[]> =>
  (await changeStreamCursors(database.name())).filter((id) => !before.includes(id));

/** Waits until the cursors new since `before` are exactly `count`. */
const cursorsAre = (before: readonly string[], count: number, timeout: number): Promise<void> =>
  vi.waitFor(
    async () => {
      expect(await newSince(before)).toHaveLength(count);
    },
    { timeout, interval: 250 },
  );

/** Whether `ended` settles within `ms` (the wait is a hang bound, not a measurement). */
const endsWithin = async (ended: Promise<void>, ms: number): Promise<boolean> =>
  Promise.race([ended.then(() => true), sleep(ms).then(() => false)]);

const streaming = (proxy: { readonly streams: number }): Promise<void> =>
  vi.waitFor(() => {
    expect(proxy.streams).toBeGreaterThan(0);
  }, CONNECTS);

describe("agbossjs/agboss#1088: the queue watch leaves no cursor on the server", () => {
  it("a healthy watch's close() leaves none", async () => {
    const before = await changeStreamCursors(database.name());
    const queue = new MongoChildExecutionQueueRepository(
      connectionTo(database.url()),
      new RealClock(),
      new TestApplicationContext("instance-1"),
      new RecordingLogger(),
    );
    const watch = await watching(queue, cleanups);
    await cursorsAre(before, 1, 15_000);
    await sleep(1500);
    await cursorsAre(before, 1, 5000);

    await watch.close();
    await cursorsAre(before, 0, 5000);
  }, 40_000);

  it.each([2, 4, 10])(
    "reopened after the change stream's connection went black, bound %i s: the dropped stream's cursor is gone, one remains, none after close()",
    async (bound) => {
      const before = await changeStreamCursors(database.name());
      const { proxy, watched, direct, logger } = await instances(database, cleanups, {
        clock: new RealClock(),
        livenessSeconds: bound,
      });
      const watch = await watching(watched, cleanups);
      await streaming(proxy);
      await cursorsAre(before, 1, 15_000);

      proxy.cutStreams();
      await direct.saveIfAbsent(child(`k-${String(bound)}`));
      await vi.waitFor(() => {
        expect(logger.entries).toHaveLength(1);
      }, CONNECTS);
      await vi.waitFor(() => {
        expect(watch.wakes()).toBeGreaterThanOrEqual(1);
      }, CONNECTS);
      await cursorsAre(before, 1, 3 * seconds(bound) + 15_000);
      await sleep(1500);
      await cursorsAre(before, 1, 1000);

      // the kill left the current stream alone: it still hears a child saved now
      const wakes = watch.wakes();
      await direct.saveIfAbsent(child(`k-after-${String(bound)}`));
      await vi.waitFor(() => {
        expect(watch.wakes()).toBeGreaterThan(wakes);
      }, CONNECTS);
      await cursorsAre(before, 1, 1000);

      await watch.close();
      await cursorsAre(before, 0, 5000);
    },
    90_000,
  );

  it.each([0, 1000, 1200, 2500])(
    "closed %i ms into a reopen: none remain",
    async (delay) => {
      const before = await changeStreamCursors(database.name());
      const { proxy, watched, direct, logger } = await instances(database, cleanups, {
        clock: new RealClock(),
        livenessSeconds: 2,
      });
      const watch = await watching(watched, cleanups);
      await streaming(proxy);
      await cursorsAre(before, 1, 15_000);

      proxy.cutStreams();
      await direct.saveIfAbsent(child(`r-${String(delay)}`));
      await vi.waitFor(() => {
        expect(logger.entries).toHaveLength(1);
      }, CONNECTS);
      await sleep(delay);

      await watch.close();
      await cursorsAre(before, 0, 8000);
    },
    60_000,
  );

  it("a kill the server cannot be reached for is warned about, and close() still ends within its bound", async () => {
    const before = await changeStreamCursors(database.name());
    const { proxy, watched, direct, logger } = await instances(database, cleanups, {
      clock: new RealClock(),
      livenessSeconds: 2,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    cleanups.push(() => {
      process.off("unhandledRejection", onUnhandled);
      return Promise.resolve();
    });
    const watch = await watching(watched, cleanups);
    await streaming(proxy);
    await cursorsAre(before, 1, 15_000);

    // the stream's connection goes black and every new one is swallowed: the reopen never
    // succeeds, and close() has only a client made for the kill, which cannot connect either
    proxy.cutStreams();
    proxy.swallowNew(true);
    await direct.saveIfAbsent(child("u-1"));
    await vi.waitFor(() => {
      expect(logger.entries).toHaveLength(1);
    }, CONNECTS);
    expect(await endsWithin(watch.close(), 6000)).toBe(true);
    expect(logger.entries.filter((e) => e.message.includes("killed"))).toHaveLength(1);
    await sleep(1500);
    expect(unhandled).toEqual([]);
  }, 60_000);

  it("the command events of the watch's client are no longer heard once the watch is closed", async () => {
    // read per client: only the watch's own client listens for `commandSucceeded`, and a late close
    // of an earlier test's client calls `off` on the prototype too
    const on = vi.spyOn(MongoClient.prototype, "on");
    const off = vi.spyOn(MongoClient.prototype, "off");
    try {
      const queue = new MongoChildExecutionQueueRepository(
        connectionTo(database.url()),
        new RealClock(),
        new TestApplicationContext("instance-1"),
        new RecordingLogger(),
      );
      const watch = await watching(queue, cleanups);
      const index = on.mock.calls.findIndex((call) => call[0] === "commandSucceeded");
      expect(index).toBeGreaterThanOrEqual(0);
      const client = on.mock.contexts[index];
      const listener = on.mock.calls[index]?.[1];
      const removed = (): boolean =>
        off.mock.calls.some(
          (call, at) =>
            call[0] === "commandSucceeded" &&
            call[1] === listener &&
            off.mock.contexts[at] === client,
        );
      expect(removed()).toBe(false);
      await watch.close();
      expect(removed()).toBe(true);
    } finally {
      on.mockRestore();
      off.mockRestore();
    }
  }, 30_000);
});

/**
 * The server has one `failCommand` fail point, so the tests that set one hold the lock of
 * `holdFailPoints` — and only these: the lock is held for the describe, not for the file, so a
 * mutant that makes this file slow does not make the other test runs of the shard wait for it
 * (agbossjs/agboss#91).
 */
describe("agbossjs/agboss#1088: a kill the server rejects", () => {
  holdFailPoints();

  it("a kill the server rejects is warned about once, and close() still ends within its bound", async () => {
    const before = await changeStreamCursors(database.name());
    const { proxy, watched, direct, logger } = await instances(database, cleanups, {
      clock: new RealClock(),
      livenessSeconds: 2,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    cleanups.push(() => {
      process.off("unhandledRejection", onUnhandled);
      return Promise.resolve();
    });
    const watch = await watching(watched, cleanups);
    await streaming(proxy);
    await cursorsAre(before, 1, 15_000);

    const admin = new MongoClient(REPLICA_SET_URL);
    cleanups.push(() => admin.close());
    const failPoint = (mode: string): Promise<unknown> =>
      admin.db("admin").command({
        configureFailPoint: "failCommand",
        mode,
        data: { failCommands: ["killCursors"], errorCode: 2 },
      });
    cleanups.push(async () => {
      await failPoint("off");
    });
    await failPoint("alwaysOn");

    proxy.cutStreams();
    await direct.saveIfAbsent(child("f-1"));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBeGreaterThanOrEqual(1);
    }, CONNECTS);
    await vi.waitFor(
      () => {
        expect(logger.entries.filter((e) => e.message.includes("killed"))).toHaveLength(1);
      },
      { timeout: 20_000 },
    );
    expect(await endsWithin(watch.close(), 5000)).toBe(true);
    // the stop kills the current stream's cursor by id too (agbossjs/agboss#1345), and the server rejects that kill
    // as well: one more warning, for that cursor, and no kill is tried again
    await sleep(1500);
    expect(logger.entries.filter((e) => e.message.includes("killed"))).toHaveLength(2);
    expect(unhandled).toEqual([]);
  }, 60_000);
});

/**
 * agbossjs/agboss#1169: `useBigInt64=true` in the URL makes every cursor id of a reply a `bigint`
 * (by default a `Long`, or a `number` when it fits in 53 bits). The listener recorded them with
 * `Long` methods, threw on the command's path, and the stream reopened in a loop and left its
 * cursors on the server.
 */
describe("agbossjs/agboss#1169: a cursor id that is a bigint", () => {
  it("one stream, no reopen, one wake per queued child, and no cursor left after close()", async () => {
    const before = await changeStreamCursors(database.name());
    const url = `${database.url()}${database.url().includes("?") ? "&" : "?"}useBigInt64=true`;
    const connection = new MongoConnection({ url, watchLivenessSeconds: 2 });
    cleanups.push(() => connection.onDestroy());
    const logger = new RecordingLogger();
    const queue = new MongoChildExecutionQueueRepository(
      connection,
      new RealClock(),
      new TestApplicationContext("instance-1"),
      logger,
    );
    const watch = await watching(queue, cleanups);
    await cursorsAre(before, 1, 15_000);

    // a window long enough for the loop of the bug (a reopen every liveness bound) to show
    await sleep(5000);
    await cursorsAre(before, 1, 1000);
    expect(watch.wakes()).toBe(0);

    await queue.saveIfAbsent(child("b-1"));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBe(1);
    }, CONNECTS);
    await queue.saveIfAbsent(child("b-2"));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBe(2);
    }, CONNECTS);
    await sleep(2500);
    expect(watch.wakes()).toBe(2);
    expect(logger.entries).toEqual([]);
    await cursorsAre(before, 1, 1000);

    await watch.close();
    await cursorsAre(before, 0, 5000);
  }, 60_000);
});

/**
 * agbossjs/agboss#1345: a stop's `close()` leaves no cursor on the server even when the stream's
 * own `killCursors` cannot go out inside the close's bound. The stream's one connection is held by
 * a `getMore` the server delays (a loaded server: here a fail point, on this test's client only,
 * by its `appName`), the `killCursors` of the stream's close queues behind it, the bound passes and
 * the client's sockets go: the cursor is then killed by id over a client made for it.
 */
describe("agbossjs/agboss#1345: a close whose own kill cannot go out in time", () => {
  holdFailPoints();
  const APP = "queue-watch-1345";

  it("the cursor is killed by id, and close() ends within its bounds", async () => {
    const before = await changeStreamCursors(database.name());
    const url = `${database.url()}${database.url().includes("?") ? "&" : "?"}appName=${APP}`;
    const connection = new MongoConnection({ url, watchLivenessSeconds: 2 });
    cleanups.push(() => connection.onDestroy());
    const queue = new MongoChildExecutionQueueRepository(
      connection,
      new RealClock(),
      new TestApplicationContext("instance-1"),
      new RecordingLogger(),
    );
    const watch = await watching(queue, cleanups);
    await cursorsAre(before, 1, 15_000);

    const admin = new MongoClient(REPLICA_SET_URL);
    cleanups.push(() => admin.close());
    cleanups.push(async () => {
      await admin.db("admin").command({ configureFailPoint: "failCommand", mode: "off" });
    });
    await admin.db("admin").command({
      configureFailPoint: "failCommand",
      mode: "alwaysOn",
      data: { failCommands: ["getMore"], appName: APP, blockConnection: true, blockTimeMS: 3000 },
    });
    // the stream's next `getMore` (one every 500 ms) is now held: its connection is busy past the bound
    await sleep(1500);

    expect(await endsWithin(watch.close(), 8000)).toBe(true);
    await cursorsAre(before, 0, 5000);
  }, 60_000);

  it("an aggregate still in flight when the stop lands: close() waits for its reply, then kills its cursor", async () => {
    const before = await changeStreamCursors(database.name());
    const app = `${APP}-aggregate`;
    const url = `${database.url()}${database.url().includes("?") ? "&" : "?"}appName=${app}`;
    // the server drops an aggregate whose client has gone before it ran, so what tells the wait is when
    // the client is closed: the stream's aggregate must have been answered by then
    let answered = false;
    let answeredAtClose: boolean | undefined;
    const on = Reflect.get(MongoClient.prototype, "on") as (
      this: MongoClient,
      ...args: unknown[]
    ) => unknown;
    const close = Object.getOwnPropertyDescriptor(MongoClient.prototype, "close")?.value as (
      this: MongoClient,
    ) => Promise<void>;
    const hooked = new Set<MongoClient>();
    const spyOn = vi.spyOn(MongoClient.prototype, "on").mockImplementation(function (
      this: MongoClient,
      ...args: unknown[]
    ) {
      if (args[0] === "commandSucceeded" && this.options.appName === app && !hooked.has(this)) {
        hooked.add(this);
        on.call(this, "commandSucceeded", (event: { commandName: string }) => {
          if (event.commandName === "aggregate") answered = true;
        });
      }
      return on.call(this, ...args) as MongoClient;
    });
    const spyClose = vi.spyOn(MongoClient.prototype, "close").mockImplementation(function (
      this: MongoClient,
    ) {
      if (this.options.appName === app) answeredAtClose ??= answered;
      return close.call(this);
    });
    cleanups.push(() => {
      spyOn.mockRestore();
      spyClose.mockRestore();
      return Promise.resolve();
    });
    const connection = new MongoConnection({ url, watchLivenessSeconds: 2 });
    cleanups.push(() => connection.onDestroy());
    const queue = new MongoChildExecutionQueueRepository(
      connection,
      new RealClock(),
      new TestApplicationContext("instance-1"),
      new RecordingLogger(),
    );
    const admin = new MongoClient(REPLICA_SET_URL);
    cleanups.push(() => admin.close());
    cleanups.push(async () => {
      await admin.db("admin").command({ configureFailPoint: "failCommand", mode: "off" });
    });
    // the stream's `aggregate` is held 1.2 s by the server (the liveness bound is 2 s)
    await admin.db("admin").command({
      configureFailPoint: "failCommand",
      mode: "alwaysOn",
      data: {
        failCommands: ["aggregate"],
        appName: app,
        blockConnection: true,
        blockTimeMS: 1200,
      },
    });
    const watch = await watching(queue, cleanups);

    expect(await endsWithin(watch.close(), 8000)).toBe(true);
    expect(answeredAtClose).toBe(true);
    await sleep(2500);
    await cursorsAre(before, 0, 3000);
  }, 60_000);
});
