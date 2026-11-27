/**
 * agbossjs/agboss#1341d, #1303c on MongoDB: a record's status write is ONE transaction with its
 * thread's activity and its status-history document; the memory sweep (`deleteIdleThreads`) empties
 * an idle thread — never one with a live record or a live tree — and leaves an owned thread as a
 * tombstone only its owner restarts.
 */
import { ExecutionRecordStatus, StatusTrigger, ThreadStatus } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { minutes } from "@agboss/core/units";
import { beforeEach, describe, expect, it } from "vitest";
import { Collections, MongoExecutionRecordRepository } from "../../src/index.js";
import { idOf } from "../../src/stores/keys.js";
import { TestApplicationContext } from "../support/application-context.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { connectionTo, CountingIdGenerator, outcomeOf, recordOf } from "../support/stores.js";

const database = testDatabase();

// the tests count whole collections: each starts from an empty database
beforeEach(() => emptyAll(database.url()));
const { Answered, Paused, Running, Failed } = ExecutionRecordStatus;
const WORKFLOW = "desk-workflow";

function storeOn(clock = new VirtualClock()) {
  const connection = connectionTo(database.url());
  return {
    clock,
    connection,
    records: new MongoExecutionRecordRepository(
      connection,
      clock,
      new TestApplicationContext(),
      new CountingIdGenerator(),
    ),
  };
}

const newThread = (records: MongoExecutionRecordRepository, ownerId?: string) =>
  records.createThread({
    workflow: WORKFLOW,
    tenantId: "default",
    ...(ownerId === undefined ? {} : { ownerId }),
  });

describe("the status history of a record's writes", () => {
  it("append, complete and completeIfStatus each write the change they make, in the write's transaction", async () => {
    const { records } = storeOn();
    const threadId = await newThread(records);
    const { id } = await records.append(recordOf(threadId, Running));
    await records.completeIfStatus(id, Running, outcomeOf(Paused));
    await records.completeIfStatus(id, Running, outcomeOf(Failed)); // lost: writes nothing
    await records.complete(id, outcomeOf(Answered));

    const history = await records.statusHistory("default", threadId);

    expect(
      history.map((entry) => [entry.seq, entry.fromStatus, entry.toStatus, entry.trigger]),
    ).toEqual([
      [1, null, ThreadStatus.Running, StatusTrigger.Start],
      [2, ThreadStatus.Running, ThreadStatus.Paused, StatusTrigger.Ask],
      [3, ThreadStatus.Paused, ThreadStatus.Finished, StatusTrigger.Finish],
    ]);
  });

  it("a command's context names the trigger, the reason and the actor of its write", async () => {
    const { records } = storeOn();
    const threadId = await newThread(records);

    await records.append(recordOf(threadId, Paused), {
      toStatus: ThreadStatus.ExternallyPaused,
      trigger: StatusTrigger.Pause,
      reason: "audit",
      actor: "ops-1",
      leaseToken: 2,
    });

    expect(await records.statusHistory("default", threadId)).toMatchObject([
      {
        toStatus: ThreadStatus.ExternallyPaused,
        trigger: StatusTrigger.Pause,
        reason: "audit",
        actor: "ops-1",
        leaseToken: 2,
      },
    ]);
  });

  it("forgetStatusHistory removes the thread's history and nothing else's; a thread with none is a no-op", async () => {
    const { records } = storeOn();
    const one = await newThread(records);
    const two = await newThread(records);
    await records.append(recordOf(one, Running));
    await records.append(recordOf(two, Running));

    await records.forgetStatusHistory("default", one);
    await records.forgetStatusHistory("default", "no-such-thread");

    expect(await records.statusHistory("default", one)).toEqual([]);
    expect(await records.statusHistory("default", two)).toHaveLength(1);
  });

  it("a record written to a swept thread is refused, and nothing of it is kept", async () => {
    const { records, connection } = storeOn();
    const threadId = await newThread(records, "owner-1");
    await connection.db
      .collection<{ _id: string }>(Collections.Threads)
      .updateOne({ _id: idOf("default", threadId) }, { $set: { isSwept: true } });

    await expect(records.append(recordOf(threadId, Running))).rejects.toThrow(/swept/);

    expect(await records.statusHistory("default", threadId)).toEqual([]);
  });
});

describe("the memory sweep", () => {
  const cutoffs = (at: Date) => new Map([[WORKFLOW, at]]);
  const ended = () => Promise.resolve(true);

  it("empties an idle thread of its records, summaries, history and pause answers; an unowned thread goes whole", async () => {
    const { records, clock, connection } = storeOn();
    const threadId = await newThread(records);
    await records.append(recordOf(threadId, Answered, { runId: "run-9" }));
    await clock.advance(minutes(10));

    expect(await records.deleteIdleThreads(cutoffs(clock.now()), ended)).toBe(1);

    expect(await records.lastTurns("default", threadId, 10)).toEqual([]);
    expect(await records.statusHistory("default", threadId)).toEqual([]);
    expect(await records.threadOwner(WORKFLOW, "default", threadId)).toBeUndefined();
    expect(await connection.db.collection(Collections.Threads).countDocuments()).toBe(0);
  });

  it("an owned thread stays as a tombstone: its owner is kept, the thread is swept, and only its owner restarts it", async () => {
    const { records, clock } = storeOn();
    const threadId = await records.createThread({
      workflow: WORKFLOW,
      tenantId: "default",
      ownerId: "owner-1",
      threadId: "own-thread",
    });
    await records.append(recordOf(threadId, Answered));
    await clock.advance(minutes(10));

    await records.deleteIdleThreads(cutoffs(clock.now()), ended);

    expect(await records.threadOwner(WORKFLOW, "default", threadId)).toEqual({
      owner: "owner-1",
      isSwept: true,
    });
    await expect(
      records.createThread({
        workflow: WORKFLOW,
        tenantId: "default",
        threadId,
        ownerId: "owner-2",
      }),
    ).rejects.toThrow(/another owner/);
    await records.createThread({
      workflow: WORKFLOW,
      tenantId: "default",
      threadId,
      ownerId: "owner-1",
    });
    expect(await records.threadOwner(WORKFLOW, "default", threadId)).toEqual({ owner: "owner-1" });
  });

  it.each([Running, Paused, ExecutionRecordStatus.Queued])(
    "a thread with a %s record is never removed",
    async (status) => {
      const { records, clock } = storeOn();
      const threadId = await newThread(records);
      await records.append(recordOf(threadId, status));
      await clock.advance(minutes(10));

      expect(await records.deleteIdleThreads(cutoffs(clock.now()), ended)).toBe(0);

      expect(await records.lastTurns("default", threadId, 10)).toHaveLength(1);
    },
  );

  it("a thread whose run is not known to have ended, or that was active after the cutoff, is kept", async () => {
    const { records, clock } = storeOn();
    const live = await newThread(records);
    await records.append(recordOf(live, Answered, { runId: "run-live" }));
    const recent = await newThread(records);
    await clock.advance(minutes(10));
    await records.append(recordOf(recent, Answered, { runId: "run-recent" }));

    const removed = await records.deleteIdleThreads(
      cutoffs(new Date(clock.now().getTime() - 1000)),
      (tree) => Promise.resolve(tree.rootExecutionId !== "run-live"),
    );

    expect(removed).toBe(0);
    expect(await records.lastTurns("default", live, 10)).toHaveLength(1);
    expect(await records.lastTurns("default", recent, 10)).toHaveLength(1);
  });

  it("another workflow's threads are not swept", async () => {
    const { records, clock } = storeOn();
    const threadId = await newThread(records);
    await records.append(recordOf(threadId, Answered));
    await clock.advance(minutes(10));

    expect(await records.deleteIdleThreads(new Map([["other-workflow", clock.now()]]), ended)).toBe(
      0,
    );

    expect(await records.lastTurns("default", threadId, 10)).toHaveLength(1);
  });
});
