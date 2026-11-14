/**
 * agbossjs/agboss#789: the child queue's change stream notices a connection that dies silently —
 * through a TCP proxy that drops every byte with no FIN and no RST (`socket.destroy()` would be a
 * FIN). The instance warns within `mongodbWatchLivenessSeconds` (a ping every half, an answer due
 * in the other half, on the clock), opens the stream on a new client after the first pause, wakes
 * once (the catch-up), then hears the next save. The driver alone takes 40 s to see such a
 * connection.
 */
import { LogLevel } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../support/database.js";
import { CONNECTS, child, instances, watching } from "../support/silent-watch.js";

const database = testDatabase();
const LIVENESS_SECONDS = 10;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const clock = new VirtualClock();
  return {
    clock,
    ...(await instances(database, cleanups, { clock, livenessSeconds: LIVENESS_SECONDS })),
  };
}

describe("agbossjs/agboss#789: the child queue's change stream on a silently dead connection", () => {
  it("agbossjs/agboss#1028 AC3: warns within the bound, opens again, wakes once with no write after the save, and hears the next save", async () => {
    const { proxy, clock, logger, watched, direct } = await setup();
    const watch = await watching(watched, cleanups);
    expect(logger.entries).toEqual([]);

    proxy.cut();
    // a ping goes out at the first half of the bound; its answer is due at the second
    await clock.advance(seconds(LIVENESS_SECONDS / 2));
    expect(logger.entries).toEqual([]);
    await clock.advance(seconds(LIVENESS_SECONDS / 2));

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      level: LogLevel.Warn,
      code: "child-queue.watch-connection-lost",
    });
    expect(watch.wakes()).toBe(0);

    // a child queued once the connection is known to be dead: the instance wakes at the new stream
    await direct.saveIfAbsent(child("c-1"));
    await clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBe(1);
    }, CONNECTS);
    await direct.saveIfAbsent(child("c-2"));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBe(2);
    }, CONNECTS);
    expect(await direct.claimFirstByStatusQueuedOrderByDepthDesc()).toMatchObject({
      executionId: "c-1",
    });
    expect(logger.entries).toHaveLength(1);
  });

  it("a new client the network swallows gives up within the bound and is retried", async () => {
    const { proxy, clock, logger, watched } = await setup();
    const watch = await watching(watched, cleanups);

    proxy.cut();
    proxy.swallowNew(true);
    await clock.advance(seconds(LIVENESS_SECONDS / 2));
    await clock.advance(seconds(LIVENESS_SECONDS / 2));
    expect(logger.entries).toHaveLength(1);
    await clock.advance(seconds(1));
    // the new client is swallowed: nothing answers its first ping, so it is dropped at the bound
    await clock.advance(seconds(LIVENESS_SECONDS));
    expect(watch.wakes()).toBe(0);

    proxy.swallowNew(false);
    await clock.advance(seconds(2));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBe(1);
    }, CONNECTS);
  });
});
