/**
 * agbossjs/agboss#1320 on MongoDB: every A2A task, message and direct message names the
 * `@A2AEndpoint` that accepted it, and the retention sweeps are per endpoint — each endpoint's rows
 * are kept for its own `ttl`; one without an entry is never swept.
 */
import { A2ATaskState, A2ATaskSaveStatus, type NewA2ATask } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import { MongoA2ATaskRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();
const NINE = new Date("2026-01-05T09:00:00.000Z");
const at = (minutes: number): Date => new Date(NINE.getTime() + minutes * 60_000);

const newTask = (endpoint: string, taskId: string, ownerId = "alice"): NewA2ATask => ({
  endpoint,
  tenantId: "acme",
  taskId,
  ownerId,
  contextId: "ctx-1",
  skill: "order-start",
  status: { state: A2ATaskState.Submitted, pendingPauses: [] },
  acceptedAt: NINE,
  messageId: `m-${taskId}`,
  requestHash: "h-1",
});

const tasksOn = () => new MongoA2ATaskRepository(connectionTo(database.url()));

describe("the endpoint of a task", () => {
  it("is kept with the task and with its message, and read back", async () => {
    const tasks = tasksOn();

    const saved = await tasks.saveIfAbsent(newTask("orders", "t-1"));

    expect(saved.status).toBe(A2ATaskSaveStatus.Saved);
    expect(await tasks.findById({ tenantId: "acme", taskId: "t-1" })).toMatchObject({
      endpoint: "orders",
    });
    expect(
      await tasks.findByMessage({ tenantId: "acme", ownerId: "alice", messageId: "m-t-1" }),
    ).toMatchObject({ endpoint: "orders" });
  });

  it("a list reads the tasks of its endpoint only", async () => {
    const tasks = tasksOn();
    await tasks.saveIfAbsent(newTask("orders", "l-1", "lister"));
    await tasks.saveIfAbsent(newTask("refunds", "l-2", "lister"));

    const page = await tasks.list({
      endpoint: "orders",
      tenantId: "acme",
      ownerId: "lister",
      pageSize: 10,
    });

    expect(page.tasks.map((task) => task.taskId)).toEqual(["l-1"]);
    expect(page.totalSize).toBe(1);
  });
});

describe("deleteExpired: per endpoint", () => {
  async function finish(
    tasks: MongoA2ATaskRepository,
    task: NewA2ATask,
    when: Date,
  ): Promise<void> {
    await tasks.compareAndSetStatus(
      task,
      1,
      { state: A2ATaskState.Completed, pendingPauses: [] },
      when,
    );
  }

  it("removes an endpoint's finished tasks past its own cutoff with their messages, counts the tasks, and leaves another endpoint's, an unfinished one and an endpoint with no entry", async () => {
    const tasks = tasksOn();
    const orders = newTask("orders", "s-orders");
    const refunds = newTask("refunds", "s-refunds");
    const open = newTask("orders", "s-open");
    const forever = newTask("forever", "s-forever");
    for (const task of [orders, refunds, open, forever]) await tasks.saveIfAbsent(task);
    await finish(tasks, orders, at(1));
    await finish(tasks, refunds, at(1));
    await finish(tasks, forever, at(1));

    const removed = await tasks.deleteExpired(new Map([["orders", at(10)]]));

    expect(removed).toBe(1);
    expect(await tasks.findById(orders)).toBeUndefined();
    expect(await tasks.findByMessage(orders)).toBeUndefined();
    for (const kept of [refunds, open, forever]) expect(await tasks.findById(kept)).toBeDefined();
    // the same instant for the other endpoints: each goes by its own cutoff
    expect(
      await tasks.deleteExpired(
        new Map([
          ["refunds", at(0)],
          ["forever", at(10)],
        ]),
      ),
    ).toBe(1);
    expect(await tasks.findById(refunds)).toBeDefined();
    expect(await tasks.findById(forever)).toBeUndefined();
  });

  it("removes the orphan messages of the endpoint (their task gone) past its cutoff, never another endpoint's, never a direct message's claim", async () => {
    const tasks = tasksOn();
    const message = (endpoint: string, messageId: string, taskId: string) => ({
      endpoint,
      tenantId: "acme",
      ownerId: "alice",
      messageId,
      requestHash: "h",
      taskId,
      savedAt: at(1),
    });
    await tasks.saveMessageIfAbsent(message("orders", "o-1", "t-gone"));
    await tasks.saveMessageIfAbsent(message("refunds", "r-1", "t-gone"));
    await tasks.saveMessageIfAbsent(message("orders", "c-1", ""));

    await tasks.deleteExpired(new Map([["orders", at(10)]]));

    expect(await tasks.findByMessage(message("orders", "o-1", ""))).toBeUndefined();
    expect(await tasks.findByMessage(message("refunds", "r-1", ""))).toBeDefined();
    expect(await tasks.findByMessage(message("orders", "c-1", ""))).toBeDefined();
  });
});
