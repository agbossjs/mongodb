/**
 * agbossjs/agboss#1129: `close()` of the child queue's watch waits for a reopen in flight. The
 * stream was lost, the pause went by, and the new client is still starting (the network swallows
 * it): a `close()` that did not wait would resolve at once and leave that client — and the stream
 * it is about to open — running after the instance stopped, and a wake after the close.
 */
import { seconds } from "@agboss/core/units";
import { VirtualClock } from "@agboss/core/testing";
import { MongoClient } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../support/database.js";
import { CONNECTS, child, instances, watching } from "../support/silent-watch.js";

const database = testDatabase();
const LIVENESS_SECONDS = 10;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The watch's own clients (one connection each), as they are made and as they are closed. */
function trackClients(): { readonly made: Set<MongoClient>; readonly closed: Set<MongoClient> } {
  const made = new Set<MongoClient>();
  const closed = new Set<MongoClient>();
  const original = (name: "db" | "close"): ((this: MongoClient, ...args: unknown[]) => unknown) =>
    Object.getOwnPropertyDescriptor(MongoClient.prototype, name)?.value as (
      this: MongoClient,
      ...args: unknown[]
    ) => unknown;
  const db = original("db");
  const close = original("close");
  vi.spyOn(MongoClient.prototype, "db").mockImplementation(function (this: MongoClient, ...args) {
    if (this.options.maxPoolSize === 1) made.add(this);
    return db.call(this, ...args) as ReturnType<MongoClient["db"]>;
  });
  vi.spyOn(MongoClient.prototype, "close").mockImplementation(function (this: MongoClient) {
    if (this.options.maxPoolSize === 1) closed.add(this);
    return close.call(this) as Promise<void>;
  });
  return { made, closed };
}

describe("agbossjs/agboss#1129: close() waits for a reopen in flight", () => {
  it("AC5: the new client is still starting at the close: it is closed when close() resolves, and nothing wakes after", async () => {
    const clock = new VirtualClock();
    const { proxy, logger, watched, direct } = await instances(database, cleanups, {
      clock,
      livenessSeconds: LIVENESS_SECONDS,
    });
    const clients = trackClients();
    const watch = await watching(watched, cleanups);
    const watchClients = clients.made.size;
    expect(watchClients).toBe(1);

    // the stream is lost; the pause goes by; the new client is swallowed: the reopen is in flight
    proxy.cut();
    proxy.swallowNew(true);
    await clock.advance(seconds(LIVENESS_SECONDS / 2));
    await clock.advance(seconds(LIVENESS_SECONDS / 2));
    expect(logger.entries).toHaveLength(1);
    await clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(clients.made.size).toBe(2);
    }, CONNECTS);

    await watch.close();

    // at the moment close() resolved, every client the watch made is closed or being closed
    expect([...clients.made].filter((client) => !clients.closed.has(client))).toEqual([]);
    const wakes = watch.wakes();
    proxy.swallowNew(false);
    await clock.advance(seconds(60));
    await direct.saveIfAbsent(child("after-close"));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(watch.wakes()).toBe(wakes);
    expect(clients.made.size).toBe(2);
  }, 60_000);
});
