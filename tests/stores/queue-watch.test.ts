import { ExecutionRecordStatus, type ChildExecutionQueueWatch } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { MongoClient } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Collections, MongoChildExecutionQueueRepository } from "../../src/index.js";
import { RecordingLogger } from "../support/recording-logger.js";
import { TestApplicationContext } from "../support/application-context.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#777 on MongoDB: the child queue's watch is a change stream on the queue. A stream
 * the server ends (the collection dropped: an `invalidate`, which no resume survives) is opened
 * again after a pause on the clock and wakes the claimers once, then hears the next save; a closed
 * watch hears nothing more.
 */
const database = testDatabase();
const clock = new VirtualClock();
const watches: ChildExecutionQueueWatch[] = [];

afterEach(async () => {
  for (const watch of watches.splice(0)) await watch.close();
});

const queueOf = (
  instanceId: string,
  logger = new RecordingLogger(),
): MongoChildExecutionQueueRepository =>
  new MongoChildExecutionQueueRepository(
    connectionTo(database.url()),
    clock,
    new TestApplicationContext({}, instanceId),
    logger,
  );

const child = (executionId: string) => ({
  tenantId: "default",
  executionId,
  rootExecutionId: "root-1",
  parentExecutionId: "root-1",
  rootWorkflow: "items-workflow",
  workflow: "item-workflow",
  depth: 2,
  status: ExecutionRecordStatus.Queued,
  run: "{}",
  queuedAt: new Date("2026-01-05T09:00:00Z"),
});

/** A watch on `queue` and how many times it woke. */
async function watching(
  queue: MongoChildExecutionQueueRepository,
): Promise<{ readonly wakes: () => number; readonly watch: ChildExecutionQueueWatch }> {
  let wakes = 0;
  const watch = await queue.watchQueued(() => {
    wakes += 1;
  });
  watches.push(watch);
  return { wakes: () => wakes, watch };
}

/** Drops the queue's collection: every change stream on it is invalidated. */
async function dropQueue(): Promise<void> {
  const client = new MongoClient(database.url());
  try {
    await client.db(database.name()).collection(Collections.ChildExecutionQueue).drop();
  } finally {
    await client.close();
  }
}

describe("agbossjs/agboss#777: the child queue's change stream", () => {
  it("a stream the server ends opens again after a pause, wakes once, then hears the next save", async () => {
    const logger = new RecordingLogger();
    const queue = queueOf("instance-2", logger);
    const watched = await watching(queue);

    await dropQueue();
    // the loss is logged right before the pause begins: one advance of the pause, no more
    await vi.waitFor(() => {
      expect(logger.entries).toHaveLength(1);
    });
    await clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(watched.wakes()).toBe(1);
    });

    await queueOf("instance-1").saveIfAbsent(child("c-1"));
    await vi.waitFor(() => {
      expect(watched.wakes()).toBe(2);
    });
    expect(await queue.claimFirstByStatusQueuedOrderByDepthDesc()).toMatchObject({
      executionId: "c-1",
    });
  });

  it("a closed watch hears nothing more; an open one hears the save", async () => {
    const closed = await watching(queueOf("instance-2"));
    await closed.watch.close();
    const open = await watching(queueOf("instance-3"));

    await queueOf("instance-1").saveIfAbsent(child("c-2"));

    await vi.waitFor(() => {
      expect(open.wakes()).toBe(1);
    });
    expect(closed.wakes()).toBe(0);
  });
});
