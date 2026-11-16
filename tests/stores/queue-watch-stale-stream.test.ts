/**
 * agbossjs/agboss#1051: a change stream the watch has declared dead must never wake it again. The
 * black hole is on the change stream's own connection only (the driver's monitors and every other
 * connection stay up, so the driver sees nothing wrong); the watch warns within the bound, opens a
 * new stream on a new client and wakes once, the catch-up. The old stream, left open, used to be
 * resumed by its driver once connections went through again and woke the watch for the child
 * queued in the outage a second time. Real clock, real replica set.
 */
import { seconds } from "@agboss/core/units";
import { ChangeStream, MongoClient } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordingLogger } from "../support/recording-logger.js";
import { testDatabase } from "../support/database.js";
import { RealClock, sleep } from "../support/pause.js";
import { CONNECTS, child, instances, watching } from "../support/silent-watch.js";

const database = testDatabase();
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * Long enough for the old client to give up on its silent connection (its socket timeout is the
 * bound) and for the driver to resume the stream on a new one.
 */
const settles = (bound: number): number => seconds(bound) + 3000;

/**
 * The warnings that say the watch lost its stream. A stream is lost once per liveness expiry: a ping
 * unanswered within half the bound. The kill of the dropped stream's cursor warns separately and
 * only when its own connection is too slow to answer (never fatal, #1088), so on a loaded runner
 * the count of all warnings is the machine's, not the watch's (#1182: a second warning in the 4 s
 * window, its stream reopened and lost again, or its cursor kill late).
 */
const lostWarnings = (logger: RecordingLogger): number =>
  logger.entries.filter((entry) => entry.message.includes("change stream is lost")).length;

/**
 * Waits until the watch is quiet: no new warning and no new wake for one `settles(bound)`, and
 * returns the counts. A reopen follows each loss, so what the guarantee says is counted against the
 * losses, never against wall time: one catch-up wake per reopen, and none from a stream the watch
 * dropped (agbossjs/agboss#1051). On an idle machine that is one loss and one wake, as before.
 */
async function quiet(
  watch: { readonly wakes: () => number },
  logger: RecordingLogger,
  bound: number,
): Promise<{ readonly wakes: number; readonly lost: number }> {
  const now = () => ({ wakes: watch.wakes(), lost: lostWarnings(logger) });
  for (let before = now(); ;) {
    await sleep(settles(bound));
    const after = now();
    if (after.wakes === before.wakes && after.lost === before.lost && after.wakes >= after.lost)
      return after;
    before = after;
  }
}

/** The `close` a prototype has, before a spy replaces it. */
const originalOf = (prototype: object): ((this: unknown) => Promise<void>) =>
  Object.getOwnPropertyDescriptor(prototype, "close")?.value as (this: unknown) => Promise<void>;

/** Waits until the change stream has sent its first command through `proxy`. */
const streaming = (proxy: { readonly streams: number }): Promise<void> =>
  vi.waitFor(() => {
    expect(proxy.streams).toBeGreaterThan(0);
  }, CONNECTS);

describe("agbossjs/agboss#1051: no wake from a stream the watch has dropped", () => {
  it.each([2, 4, 10])(
    "the change stream's connection black-holed, bound %i s, a child saved in the outage, no later write: exactly one wake",
    async (bound) => {
      const { proxy, watched, direct, logger } = await instances(database, cleanups, {
        clock: new RealClock(),
        livenessSeconds: bound,
      });
      const watch = await watching(watched, cleanups);

      await streaming(proxy);
      proxy.cut();
      await direct.saveIfAbsent(child(`s-${String(bound)}`));
      await vi.waitFor(() => {
        expect(lostWarnings(logger)).toBeGreaterThanOrEqual(1);
      }, CONNECTS);
      await vi.waitFor(() => {
        expect(watch.wakes()).toBeGreaterThanOrEqual(1);
      }, CONNECTS);
      const settled = await quiet(watch, logger, bound);
      // one catch-up wake per loss of the stream; the stream the watch dropped wakes it never
      expect(settled.lost).toBeGreaterThanOrEqual(1);
      expect(settled.wakes).toBe(settled.lost);

      await direct.saveIfAbsent(child(`s-next-${String(bound)}`));
      await vi.waitFor(() => {
        expect(watch.wakes()).toBeGreaterThanOrEqual(settled.wakes + 1);
      }, CONNECTS);
      await sleep(1500);
      expect(watch.wakes()).toBe(settled.wakes + 1);
    },
    60_000,
  );

  it("a child claimed in the outage and a swallowed reconnect: exactly one wake once the network is back", async () => {
    const { proxy, watched, direct, logger } = await instances(database, cleanups, {
      clock: new RealClock(),
      livenessSeconds: 2,
    });
    const watch = await watching(watched, cleanups);

    await streaming(proxy);
    proxy.cut();
    await direct.saveIfAbsent(child("c-claimed"));
    // every child queued so far is claimed, the outage's one among them: nothing is left to claim
    const claimed: string[] = [];
    for (;;) {
      const next = await direct.claimFirstByStatusQueuedOrderByDepthDesc();
      if (next === undefined) break;
      claimed.push(next.executionId);
    }
    expect(claimed).toContain("c-claimed");
    await vi.waitFor(() => {
      expect(lostWarnings(logger)).toBeGreaterThanOrEqual(1);
    }, CONNECTS);
    proxy.swallowNew(true);
    // the new clients are swallowed too: several attempts go by, each given up at the bound
    await vi.waitFor(
      () => {
        expect(proxy.accepted).toBeGreaterThanOrEqual(8);
      },
      { timeout: 40_000 },
    );
    expect(watch.wakes()).toBe(0);

    proxy.swallowNew(false);
    await vi.waitFor(() => {
      expect(watch.wakes()).toBeGreaterThanOrEqual(1);
    }, CONNECTS);
    const settled = await quiet(watch, logger, 2);
    expect(settled.wakes).toBe(settled.lost);

    await direct.saveIfAbsent(child("c-after"));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBeGreaterThanOrEqual(settled.wakes + 1);
    }, CONNECTS);
    await sleep(1500);
    expect(watch.wakes()).toBe(settled.wakes + 1);
  }, 90_000);

  it("a stale stream that its close does not stop is not heard either: the generation check alone, exactly one wake", async () => {
    // closes of the watch's streams and clients do nothing (as when the driver cannot reach the
    // server to end them): only the check that the stream is the current one stands between a
    // resumed old stream and the watch. They are really closed after the test.
    const held: (() => Promise<unknown>)[] = [];
    const streamClose = originalOf(ChangeStream.prototype);
    const clientClose = originalOf(MongoClient.prototype);
    vi.spyOn(ChangeStream.prototype, "close").mockImplementation(function (this: ChangeStream) {
      held.push(() => streamClose.call(this));
      return Promise.resolve();
    });
    vi.spyOn(MongoClient.prototype, "close").mockImplementation(function (this: MongoClient) {
      if (this.options.maxPoolSize !== 1) return clientClose.call(this);
      held.push(() => clientClose.call(this));
      return Promise.resolve();
    });
    cleanups.push(async () => {
      vi.restoreAllMocks();
      await Promise.allSettled(held.splice(0).map((close) => close()));
    });
    const { proxy, watched, direct, logger } = await instances(database, cleanups, {
      clock: new RealClock(),
      livenessSeconds: 2,
    });
    const watch = await watching(watched, cleanups);

    await streaming(proxy);
    proxy.cut();
    await direct.saveIfAbsent(child("g-1"));
    await vi.waitFor(() => {
      expect(lostWarnings(logger)).toBeGreaterThanOrEqual(1);
    }, CONNECTS);
    await vi.waitFor(() => {
      expect(watch.wakes()).toBeGreaterThanOrEqual(1);
    }, CONNECTS);
    const settled = await quiet(watch, logger, 2);
    expect(settled.wakes).toBe(settled.lost);
  }, 60_000);
});
