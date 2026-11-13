import { A2ATaskSaveStatus, A2ATaskState, type NewA2ATask } from "@agboss/core";
import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";
import { MongoA2ATaskRepository } from "../../src/index.js";
import { sweptOrphanMessagesBefore } from "../../src/stores/a2a-tasks/a2a-task-sweep.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#960 on MongoDB, the interleaving that charged a skill twice: sweep A reads an
 * orphan message and finds its task gone; sweep B (another instance) removes the orphan; a resend is
 * accepted as a new task under the same message id; sweep A then deletes what it read. The delete
 * must re-check each row, or it removes the live new task's message, and the next resend is a second
 * task. Sweep A is paused after its task read (the hold point), so the new task exists in every run.
 */
const database = testDatabase();
const NINE = new Date("2026-01-05T09:00:00.000Z");
const at = (minutes: number): Date => new Date(NINE.getTime() + minutes * 60_000);

const newTask = (taskId: string, messageId: string, acceptedAt: Date): NewA2ATask => ({
  tenantId: "default",
  taskId,
  ownerId: "alice",
  contextId: "ctx-1",
  skill: "s",
  status: { state: A2ATaskState.Submitted, pendingPauses: [] },
  acceptedAt,
  messageId,
  requestHash: "h-1",
});

/** A `Db` whose tasks collection runs `between` once, after a `find(...).toArray()` has read. */
function pausedAfterTaskRead(db: Db, between: () => Promise<void>): Db {
  let fired = false;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "collection") return Reflect.get(target, prop, receiver) as unknown;
      return (name: string) => {
        const collection = target.collection(name);
        if (name !== "agboss_a2a_tasks") return collection;
        return new Proxy(collection, {
          get(held, property, heldReceiver) {
            if (property !== "find") return Reflect.get(held, property, heldReceiver) as unknown;
            return (...args: Parameters<typeof held.find>) => {
              const cursor = held.find(...args);
              return {
                toArray: async () => {
                  const rows = await cursor.toArray();
                  if (!fired) {
                    fired = true;
                    await between();
                  }
                  return rows;
                },
              };
            };
          },
        });
      };
    },
  });
}

describe("agbossjs/agboss#960: the MongoDB orphan sweep against a resend of the orphan's message id", () => {
  it("sweep A never deletes the message of the new task a resend created after sweep B removed the orphan", async () => {
    const connection = connectionTo(database.url());
    const tasks = new MongoA2ATaskRepository(connection);
    const orphan = {
      tenantId: "default",
      ownerId: "alice",
      messageId: "m-x",
      requestHash: "h-1",
      taskId: "t-gone",
      savedAt: at(1),
    };
    expect(await tasks.saveMessageIfAbsent(orphan)).toBeUndefined();
    let resent: A2ATaskSaveStatus | undefined;
    const between = async (): Promise<void> => {
      await sweptOrphanMessagesBefore(connection.db, at(10));
      resent = (await tasks.saveIfAbsent(newTask("t-20", "m-x", at(20)))).status;
    };

    const removed = await sweptOrphanMessagesBefore(
      pausedAfterTaskRead(connection.db, between),
      at(10),
    );

    // the hold point ran: sweep B removed the orphan, the resend became a new task
    expect(resent).toBe(A2ATaskSaveStatus.Saved);
    // sweep A removed nothing: the row it read is gone, and the one now there is not what it read
    expect(removed).toBe(0);
    expect(await tasks.findByMessage(orphan)).toMatchObject({ taskId: "t-20" });
    // the next resend is the same task, never a second one
    const again = await tasks.saveIfAbsent(newTask("t-30", "m-x", at(21)));
    expect(again.status).toBe(A2ATaskSaveStatus.MessageTaken);
    expect(await tasks.findById({ tenantId: "default", taskId: "t-30" })).toBeUndefined();
  });

  it("still removes the orphans it read when nothing changed in between", async () => {
    const connection = connectionTo(database.url());
    const tasks = new MongoA2ATaskRepository(connection);
    const orphan = {
      tenantId: "default",
      ownerId: "alice",
      messageId: "m-y",
      requestHash: "h-1",
      taskId: "t-gone-2",
      savedAt: at(1),
    };
    await tasks.saveMessageIfAbsent(orphan);

    expect(await sweptOrphanMessagesBefore(connection.db, at(10))).toBe(1);

    expect(await tasks.findByMessage(orphan)).toBeUndefined();
  });
});
