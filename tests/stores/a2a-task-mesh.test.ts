import { A2ATaskState, type A2ATaskStatus, type NewA2ATask } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { Collections, MongoA2ATaskRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#810 on MongoDB: what the mesh keeps on an A2A task — the first message's
 * `meshBodyHash` (a document field), a refusal's `errorDetails` and a completion's `spentUsd` (in
 * the status's JSON text) — comes back as written on another instance; a document saved before
 * reads as untrusted (no body hash, so no run report); and a status this store cannot read in full
 * is refused, never read with a field dropped.
 */
const database = testDatabase();

const NINE = new Date("2026-01-05T09:00:00.000Z");
const HASH = `sha256:${"ab".repeat(32)}`;

const tasksOn = () => new MongoA2ATaskRepository(connectionTo(database.url()));

const newTask = (taskId: string, extra: Partial<NewA2ATask> = {}): NewA2ATask => ({
  tenantId: "acme",
  taskId,
  ownerId: "alice",
  contextId: "ctx-1",
  skill: "charge-workflow-start",
  status: { state: A2ATaskState.Submitted, pendingPauses: [] },
  acceptedAt: NINE,
  messageId: `m-${taskId}`,
  requestHash: "h-1",
  ...extra,
});

const keyOf = (taskId: string) => ({ tenantId: "acme", taskId });
const tasksCollection = () => connectionTo(database.url()).db.collection(Collections.A2ATasks);

describe("agbossjs/agboss#810: the mesh's fields of an A2A task on MongoDB", () => {
  it("the body hash, a refusal's facts and a completion's spend round-trip between instances", async () => {
    const [a, b] = [tasksOn(), tasksOn()];
    const rejected: A2ATaskStatus = {
      state: A2ATaskState.Rejected,
      pendingPauses: [],
      errorCode: "limit.hops",
      message: "the task was rejected: limit.hops",
      errorDetails: { chain: [{ application: "orders-application" }], maxMeshHops: 1 },
    };
    const completed: A2ATaskStatus = {
      state: A2ATaskState.Completed,
      pendingPauses: [],
      finish: "charged-workflow-finish",
      output: { chargeId: "ch-1" },
      spentUsd: 0.000123,
    };
    await a.saveIfAbsent(
      newTask("trusted", { callerPeer: "orders-application", meshBodyHash: HASH }),
    );
    await a.saveIfAbsent(newTask("refused", { status: rejected }));
    await a.compareAndSetStatus(keyOf("trusted"), 1, completed, NINE);

    expect(await b.findById(keyOf("trusted"))).toMatchObject({
      meshBodyHash: HASH,
      status: completed,
      version: 2,
    });
    expect((await b.findById(keyOf("refused")))?.status).toEqual(rejected);
    const listed = await b.list({ tenantId: "acme", ownerId: "alice", pageSize: 10 });
    expect(listed.tasks.find((task) => task.taskId === "trusted")?.meshBodyHash).toBe(HASH);
  });

  it("a document of before the body hash reads with none: untrusted, no run report", async () => {
    const tasks = tasksOn();
    await tasks.saveIfAbsent(newTask("old"));
    // as saved before #810: a trusted caller's task, no body hash field
    await tasksCollection().updateOne(
      { taskId: "old" },
      {
        $set: {
          callerPeer: "orders-application",
          state: A2ATaskState.Completed,
          status: JSON.stringify({ state: A2ATaskState.Completed, pendingPauses: [], spentUsd: 1 }),
        },
      },
    );

    const old = await tasks.findById(keyOf("old"));
    expect(old).toMatchObject({ callerPeer: "orders-application", status: { spentUsd: 1 } });
    expect(old).not.toHaveProperty("meshBodyHash");
  });

  it.each([
    ["a field it does not know", "unknown", { pendingPauses: [], grantedUsd: 5 }],
    ["a negative spend", "negative", { pendingPauses: [], spentUsd: -1 }],
    ["a spend that is no number", "text", { pendingPauses: [], spentUsd: "3" }],
  ])("a status with %s is refused, never read without it", async (_name, id, fields) => {
    const tasks = tasksOn();
    await tasks.saveIfAbsent(newTask(id));
    await tasksCollection().updateOne(
      { taskId: id },
      {
        $set: {
          state: A2ATaskState.Completed,
          status: JSON.stringify({ state: A2ATaskState.Completed, ...fields }),
        },
      },
    );

    await expect(tasks.findById(keyOf(id))).rejects.toThrow();
  });

  it("a body hash that is no text is refused, never read as untrusted", async () => {
    const tasks = tasksOn();
    await tasks.saveIfAbsent(newTask("bad-hash", { callerPeer: "orders-application" }));
    await tasksCollection().updateOne({ taskId: "bad-hash" }, { $set: { meshBodyHash: 42 } });

    await expect(tasks.findById(keyOf("bad-hash"))).rejects.toThrow();
  });
});
