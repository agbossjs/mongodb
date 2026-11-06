import { A2ATaskSaveStatus, A2ATaskState, type NewA2ATask } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { MongoA2ATaskRepository } from "../../src/index.js";
import { sweptTerminalBefore } from "../../src/stores/a2a-tasks/a2a-task-sweep.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#824 on MongoDB: the retention sweep removes the finished A2A tasks in bounded
 * batches, each outside a transaction — a backlog of any size never outlives a transaction's
 * lifetime — every batch's tasks first, then their messages; an unfinished task, or one that ended
 * at or after the cutoff, stays with its messages.
 */
const database = testDatabase();
const NINE = new Date("2026-01-05T09:00:00.000Z");
const at = (minutes: number): Date => new Date(NINE.getTime() + minutes * 60_000);

const newTask = (n: number): NewA2ATask => ({
  tenantId: "default",
  taskId: `t-${String(n)}`,
  ownerId: "alice",
  contextId: "ctx-1",
  skill: "order-workflow-start",
  status: { state: A2ATaskState.Submitted, pendingPauses: [] },
  acceptedAt: NINE,
  messageId: `m-${String(n)}`,
  requestHash: "h-1",
});

describe("agbossjs/agboss#824: the MongoDB A2A task sweep", () => {
  it("removes a backlog larger than one batch, batch by batch, and keeps what is not due", async () => {
    const connection = connectionTo(database.url());
    const tasks = new MongoA2ATaskRepository(connection);
    for (let n = 1; n <= 7; n += 1) {
      const save = await tasks.saveIfAbsent(newTask(n));
      expect(save.status).toBe(A2ATaskSaveStatus.Saved);
      // t-1…t-5 completed at 9:01, t-6 completed at 9:30, t-7 still working
      const done = n <= 5 ? at(1) : at(30);
      const state = n === 7 ? A2ATaskState.Working : A2ATaskState.Completed;
      await tasks.compareAndSetStatus(newTask(n), 1, { state, pendingPauses: [] }, done);
    }

    const batches = await sweptTerminalBefore(connection.db, at(20), 2);

    expect(batches).toBe(3);
    for (let n = 1; n <= 7; n += 1) {
      const kept = n > 5;
      expect((await tasks.findById(newTask(n))) !== undefined).toBe(kept);
      expect((await tasks.findByMessage(newTask(n))) !== undefined).toBe(kept);
    }
    expect(await sweptTerminalBefore(connection.db, at(20), 2)).toBe(0);
  });
});
