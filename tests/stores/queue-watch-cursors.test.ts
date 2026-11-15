/**
 * agbossjs/agboss#1088: the queue watch leaves no change-stream cursor of its own on the server.
 * The cursors are counted on every member of the real replica set (`$currentOp` with idle
 * cursors), on the test database, as the difference from what was there before the test. A watch
 * that is closed must close its stream first and its client after: the client's one connection
 * carries the stream's `killCursors`, and the client's close shuts it. A watch reopened after the
 * black hole must kill the dropped stream's cursor by id. Real clock. The black hole is on the change stream's connection only; new connections go through.
 * A stream dropped as dead cannot tell the server to drop its cursor (its one connection is the
 * dead one), so the watch kills it by id over the new stream's client; a server that cannot be
 * reached then keeps the cursor until `cursorTimeoutMillis` (10 min), which no test can check.
 */
import { seconds } from "@agboss/core/units";
import { MongoClient } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MongoChildExecutionQueueRepository } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { testDatabase } from "../support/database.js";
import { RealClock, sleep } from "../support/pause.js";
import { RecordingLogger } from "../support/recording-logger.js";
import { REPLICA_SET_URL } from "../support/server.js";
import { changeStreamCursors } from "../support/server-cursors.js";
import { connectionTo } from "../support/stores.js";
import { CONNECTS, child, instances, watching } from "../support/silent-watch.js";

const database = testDatabase();
const cleanups: (() => Promise<void>)[] = [];

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
      new TestApplicationContext({}, "instance-1"),
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
    await sleep(1500);
    expect(logger.entries.filter((e) => e.message.includes("killed"))).toHaveLength(1);
    expect(unhandled).toEqual([]);
  }, 60_000);

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
    const off = vi.spyOn(MongoClient.prototype, "off");
    const queue = new MongoChildExecutionQueueRepository(
      connectionTo(database.url()),
      new RealClock(),
      new TestApplicationContext({}, "instance-1"),
      new RecordingLogger(),
    );
    const watch = await watching(queue, cleanups);
    expect(off).not.toHaveBeenCalledWith("commandSucceeded", expect.anything());
    await watch.close();
    expect(off).toHaveBeenCalledWith("commandSucceeded", expect.anything());
    off.mockRestore();
  }, 30_000);
});
