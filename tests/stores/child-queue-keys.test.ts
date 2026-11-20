/**
 * agbossjs/agboss#81: the keys of the child queue's Mongo statements that no mutant of Stryker
 * drops (it empties a whole literal, never removes one key), each proved by a test that fails
 * without it: the order of a claim is the sort's, whatever index the plan has; a child queued again
 * loses everything its claim left, and only a child still running under that claim is queued again;
 * a completion is of the child it names, and a failed one has its end time too.
 */
import { ExecutionRecordStatus, type QueuedChildExecution } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { Collections, MongoChildExecutionQueueRepository } from "../../src/index.js";
import { idOf } from "../../src/stores/keys.js";
import { TestApplicationContext } from "../support/application-context.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { RecordingLogger } from "../support/recording-logger.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();
const QUEUE = Collections.ChildExecutionQueue;
const INSTANCE = "instance-1";
const START = Date.parse("2026-10-18T08:00:00.000Z");
const CLAIMED_AT = new Date(START + 5000);

beforeEach(() => emptyAll(database.url()));

const rawQueue = () =>
  connectionTo(database.url()).db.collection<{ _id: string } & Record<string, unknown>>(QUEUE);

const child = (executionId: string, depth: number, queuedAfter: number): QueuedChildExecution => ({
  tenantId: "default",
  executionId,
  rootExecutionId: "root",
  parentExecutionId: "parent",
  rootWorkflow: "workflow",
  workflow: "child-workflow",
  depth,
  status: ExecutionRecordStatus.Queued,
  run: "{}",
  queuedAt: new Date(START + queuedAfter),
});

function queueOn(clock = new VirtualClock()): MongoChildExecutionQueueRepository {
  return new MongoChildExecutionQueueRepository(
    connectionTo(database.url()),
    clock,
    new TestApplicationContext({}, INSTANCE),
    new RecordingLogger(),
  );
}

describe("agbossjs/agboss#81: the claim's order is its sort's", () => {
  it("the deepest first, then the longest waiting, with no index that gives the order", async () => {
    const queue = queueOn();
    for (const one of [child("a", 2, 0), child("b", 3, 2000), child("c", 3, 1000)])
      expect(await queue.saveIfAbsent(one)).toBe(true);
    // the plan then has to sort: the order is no accident of `by_claim`
    await rawQueue().dropIndex("by_claim");
    try {
      const claimed: string[] = [];
      for (let claim = 0; claim < 3; claim += 1)
        claimed.push((await queue.claimFirstByStatusQueuedOrderByDepthDesc())?.executionId ?? "-");
      expect(claimed).toEqual(["c", "b", "a"]);
    } finally {
      await rawQueue().createIndex({ status: 1, depth: -1, queuedAt: 1 }, { name: "by_claim" }, {});
    }
  });
});

describe("agbossjs/agboss#81: a child queued again", () => {
  it("loses everything its claim and its end left on the row", async () => {
    const queue = queueOn();
    await queue.saveIfAbsent(child("lost", 2, 0));
    const id = idOf("default", "lost");
    await rawQueue().updateOne(
      { _id: id },
      {
        $set: {
          status: ExecutionRecordStatus.Running,
          instanceId: "instance-2",
          claimedAt: CLAIMED_AT,
          endedAt: new Date(START + 6000),
          failure: "boom",
        },
      },
    );

    expect(await queue.saveIfAbsent({ ...child("lost", 2, 0), claimedAt: CLAIMED_AT })).toBe(true);

    const row = await rawQueue().findOne({ _id: id });
    expect(row).toMatchObject({ status: ExecutionRecordStatus.Queued });
    for (const field of ["instanceId", "claimedAt", "endedAt", "failure"])
      expect(row).not.toHaveProperty(field);
  });

  it("only a row that is running under that claim: an ended one with the same claim time stays", async () => {
    const queue = queueOn();
    await queue.saveIfAbsent(child("done", 2, 0));
    const id = idOf("default", "done");
    await rawQueue().updateOne(
      { _id: id },
      { $set: { status: ExecutionRecordStatus.Answered, claimedAt: CLAIMED_AT } },
    );

    expect(await queue.saveIfAbsent({ ...child("done", 2, 0), claimedAt: CLAIMED_AT })).toBe(false);

    expect(await rawQueue().findOne({ _id: id })).toMatchObject({
      status: ExecutionRecordStatus.Answered,
      claimedAt: CLAIMED_AT,
    });
  });
});

describe("agbossjs/agboss#81: a completion", () => {
  it("is of the child it names: another child this instance runs, stored before it, is left running", async () => {
    const queue = queueOn();
    await queue.saveIfAbsent(child("one", 3, 0));
    await queue.saveIfAbsent(child("two", 2, 1000));
    await queue.claimFirstByStatusQueuedOrderByDepthDesc();
    await queue.claimFirstByStatusQueuedOrderByDepthDesc();

    expect(
      await queue.completeByTenantIdAndExecutionId("default", "two", {
        status: ExecutionRecordStatus.Answered,
      }),
    ).toBe(true);

    expect(await rawQueue().findOne({ _id: idOf("default", "one") })).toMatchObject({
      status: ExecutionRecordStatus.Running,
    });
    expect(await rawQueue().findOne({ _id: idOf("default", "one") })).not.toHaveProperty("endedAt");
    expect(await rawQueue().findOne({ _id: idOf("default", "two") })).toMatchObject({
      status: ExecutionRecordStatus.Answered,
    });
  });

  it("a failed one has the time it ended, as an answered one", async () => {
    const clock = new VirtualClock();
    const queue = queueOn(clock);
    await queue.saveIfAbsent(child("bad", 2, 0));
    await queue.claimFirstByStatusQueuedOrderByDepthDesc();

    await queue.completeByTenantIdAndExecutionId("default", "bad", {
      status: ExecutionRecordStatus.Failed,
      failure: "boom",
    });

    expect(await rawQueue().findOne({ _id: idOf("default", "bad") })).toMatchObject({
      status: ExecutionRecordStatus.Failed,
      failure: "boom",
      endedAt: clock.now(),
    });
  });
});
