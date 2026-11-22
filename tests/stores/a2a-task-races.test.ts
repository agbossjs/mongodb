import { A2ATaskSaveStatus, A2ATaskState, type A2ATaskStatus, type NewA2ATask } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { MongoA2ATaskRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/mongodb#105: the A2A task store's two once-only claims, each raced by writers on
 * instances of their own (a connection each), released together once every instance is warm:
 * of N pods accepting one message exactly one saves it, and of N status writes at one version
 * exactly one lands. A read-then-write in place of the transaction or of the filtered update lets
 * two through in some round, so each case runs several rounds.
 */
const database = testDatabase();

const NINE = new Date("2026-01-05T09:00:00.000Z");
const WRITERS = 4;
const ROUNDS = 8;

const instances = async (): Promise<MongoA2ATaskRepository[]> => {
  const stores = Array.from(
    { length: WRITERS },
    () => new MongoA2ATaskRepository(connectionTo(database.url())),
  );
  await Promise.all(stores.map((store) => store.ping()));
  return stores;
};

/** `work` of every instance at once: all started before any is awaited, after a common release. */
async function together<T>(
  stores: readonly MongoA2ATaskRepository[],
  work: (store: MongoA2ATaskRepository, index: number) => Promise<T>,
): Promise<T[]> {
  let release: () => void = () => undefined;
  const go = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = stores.map(async (store, index) => {
    await go;
    return work(store, index);
  });
  release();
  return Promise.all(running);
}

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

const working: A2ATaskStatus = { state: A2ATaskState.Working, pendingPauses: [] };
const completed: A2ATaskStatus = { state: A2ATaskState.Completed, pendingPauses: [] };

describe("agbossjs/mongodb#105: the A2A task store under concurrent writers", () => {
  it("one message accepted on several instances at once is saved by exactly one", async () => {
    const stores = await instances();
    for (let round = 0; round < ROUNDS; round += 1) {
      const messageId = `m-race-${String(round)}`;

      const saves = await together(stores, (store, index) =>
        store.saveIfAbsent(newTask(`t-${String(round)}-${String(index)}`, { messageId })),
      );

      expect(saves.filter((save) => save.status === A2ATaskSaveStatus.Saved)).toHaveLength(1);
      expect(saves.filter((save) => save.status === A2ATaskSaveStatus.MessageTaken)).toHaveLength(
        WRITERS - 1,
      );
      const winner = saves.find((save) => save.status === A2ATaskSaveStatus.Saved);
      const stored = await stores[0]?.findByMessage({
        tenantId: "acme",
        ownerId: "alice",
        messageId,
      });
      expect(stored?.taskId).toBe(winner?.status === A2ATaskSaveStatus.Saved && winner.task.taskId);
    }
  });

  it("one task id claimed by several messages at once is saved once", async () => {
    const stores = await instances();
    for (let round = 0; round < ROUNDS; round += 1) {
      const taskId = `t-same-${String(round)}`;

      const saves = await together(stores, (store, index) =>
        store.saveIfAbsent(newTask(taskId, { messageId: `m-${String(round)}-${String(index)}` })),
      );

      expect(saves.filter((save) => save.status === A2ATaskSaveStatus.Saved)).toHaveLength(1);
      expect((await stores[0]?.findById({ tenantId: "acme", taskId }))?.version).toBe(1);
    }
  });

  it("status writes at one version on several instances at once: exactly one lands", async () => {
    const stores = await instances();
    for (let round = 0; round < ROUNDS; round += 1) {
      const taskId = `t-cas-${String(round)}`;
      await stores[0]?.saveIfAbsent(newTask(taskId));

      const written = await together(stores, (store) =>
        store.compareAndSetStatus({ tenantId: "acme", taskId }, 1, working, NINE),
      );

      expect(written.filter((task) => task !== undefined)).toHaveLength(1);
      const stored = await stores[0]?.findById({ tenantId: "acme", taskId });
      expect(stored).toMatchObject({ version: 2, status: working });
    }
  });

  it("a terminal write and a later one at once: the first terminal status is never written over", async () => {
    const stores = await instances();
    for (let round = 0; round < ROUNDS; round += 1) {
      const taskId = `t-term-${String(round)}`;
      await stores[0]?.saveIfAbsent(newTask(taskId));

      const written = await together(stores, (store, index) =>
        store.compareAndSetStatus(
          { tenantId: "acme", taskId },
          1,
          index % 2 === 0 ? completed : working,
          NINE,
        ),
      );

      expect(written.filter((task) => task !== undefined)).toHaveLength(1);
      const stored = await stores[0]?.findById({ tenantId: "acme", taskId });
      expect(stored?.version).toBe(2);
      // whatever landed, a terminal one is never moved by a write at its own version
      if (stored?.status.state === A2ATaskState.Completed)
        expect(
          await stores[1]?.compareAndSetStatus({ tenantId: "acme", taskId }, 2, working, NINE),
        ).toBeUndefined();
    }
  });
});
