/**
 * agbossjs/agboss#1028: a new change stream starts strictly after the last write the watch saw —
 * the open time, or the cluster time of the reopen's `ping` — and never replays it. A reopen wakes
 * the claimers exactly once (the catch-up), as the PostgreSQL and Redis stores do; an open wakes
 * nobody for a write made before it.
 */
import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../support/database.js";
import { RealClock, sleep } from "../support/pause.js";
import { CONNECTS, child, instances, watching } from "../support/silent-watch.js";

const database = testDatabase();
const cleanups: (() => Promise<void>)[] = [];
/** A replayed event reaches the watch within milliseconds of the stream's start: well inside this. */
const SETTLES_MS = 1500;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("agbossjs/agboss#1028: where a new stream starts", () => {
  it("AC1 (virtual clock): a child saved in the outage, no later write: the reopen wakes exactly once", async () => {
    const clock = new VirtualClock();
    const { proxy, watched, direct, logger } = await instances(database, cleanups, {
      clock,
      livenessSeconds: 10,
    });
    const watch = await watching(watched, cleanups);

    proxy.cut();
    await direct.saveIfAbsent(child("v-1"));
    await clock.advance(seconds(5));
    await clock.advance(seconds(5));
    expect(logger.entries).toHaveLength(1);
    await clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBeGreaterThanOrEqual(1);
    }, CONNECTS);
    await sleep(SETTLES_MS);
    expect(watch.wakes()).toBe(1);

    await direct.saveIfAbsent(child("v-2"));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBeGreaterThanOrEqual(2);
    }, CONNECTS);
    await sleep(SETTLES_MS);
    expect(watch.wakes()).toBe(2);
  });

  it("AC1 (real clock): a child saved in the outage, no later write: the reopen wakes exactly once", async () => {
    const { proxy, watched, direct, logger } = await instances(database, cleanups, {
      clock: new RealClock(),
      livenessSeconds: 2,
    });
    const watch = await watching(watched, cleanups);

    proxy.cut();
    await direct.saveIfAbsent(child("r-1"));
    await vi.waitFor(() => {
      expect(logger.entries).toHaveLength(1);
    }, CONNECTS);
    await vi.waitFor(() => {
      expect(watch.wakes()).toBeGreaterThanOrEqual(1);
    }, CONNECTS);
    await sleep(SETTLES_MS);
    expect(watch.wakes()).toBe(1);

    await direct.saveIfAbsent(child("r-2"));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBeGreaterThanOrEqual(2);
    }, CONNECTS);
    await sleep(SETTLES_MS);
    expect(watch.wakes()).toBe(2);
  });

  it("AC2: a child saved, then the watch opened with no later write: no wake until the next save", async () => {
    const clock = new VirtualClock();
    const { watched, direct } = await instances(database, cleanups, { clock, livenessSeconds: 10 });
    await direct.saveIfAbsent(child("a-1"));

    const watch = await watching(watched, cleanups);
    await sleep(SETTLES_MS);
    expect(watch.wakes()).toBe(0);

    await direct.saveIfAbsent(child("a-2"));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBeGreaterThanOrEqual(1);
    }, CONNECTS);
    await sleep(SETTLES_MS);
    expect(watch.wakes()).toBe(1);
  });
});
