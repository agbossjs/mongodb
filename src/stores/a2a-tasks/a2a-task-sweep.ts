import { DIRECT_MESSAGE_CLAIM } from "@agboss/core/stores";
import type { Db } from "mongodb";
import { Collections } from "../../connection/collections.js";
import {
  taskIdOf,
  TERMINAL_STATES,
  type A2AMessageDocument,
  type A2ATaskDocument,
} from "./a2a-task-documents.js";

/** How many finished tasks one batch of the sweep removes. */
const SWEEP_BATCH = 500;

/**
 * The retention sweep of `MongoA2ATaskRepository` (agbossjs/agboss#824): the terminal tasks whose
 * status changed before `cutoff`, `batchSize` at a time, each batch's tasks then their messages,
 * every command on its own. Resolves with the number of batches it removed.
 */
export async function sweptTerminalBefore(
  db: Db,
  cutoff: Date,
  batchSize = SWEEP_BATCH,
): Promise<number> {
  const tasks = db.collection<A2ATaskDocument>(Collections.A2ATasks);
  const messages = db.collection<A2AMessageDocument>(Collections.A2AMessages);
  const due = { state: { $in: [...TERMINAL_STATES] }, statusAt: { $lt: cutoff } };
  for (let batches = 0; ; batches += 1) {
    const batch = await tasks
      .find(due, { projection: { tenantId: 1, taskId: 1 }, limit: batchSize })
      .toArray();
    if (batch.length === 0) return batches;
    await tasks.deleteMany({ ...due, _id: { $in: batch.map((task) => task._id) } });
    await messages.deleteMany({
      $or: batch.map(({ tenantId, taskId }) => ({ tenantId, taskId })),
    });
  }
}

/**
 * The messages whose task is gone and whose `savedAt` is before `cutoff` (agbossjs/agboss#960): a
 * follow-up saved while the sweep removed its task, or a message the crash between a batch's two
 * commands left — which a resend would read as accepted before. Read by `_id`, `batchSize` at a
 * time; a message and its task are saved in one transaction, so a message without a task is never a
 * new task's, and a direct message's claim has no task by design (agbossjs/agboss#860): never an
 * orphan. Resolves with the number of messages it removed.
 */
export async function sweptOrphanMessagesBefore(
  db: Db,
  cutoff: Date,
  batchSize = SWEEP_BATCH,
): Promise<number> {
  const tasks = db.collection<A2ATaskDocument>(Collections.A2ATasks);
  const messages = db.collection<A2AMessageDocument>(Collections.A2AMessages);
  let removed = 0;
  for (let after = ""; ;) {
    const batch = await messages
      .find(
        { savedAt: { $lt: cutoff }, taskId: { $ne: DIRECT_MESSAGE_CLAIM }, _id: { $gt: after } },
        { projection: { tenantId: 1, taskId: 1 }, sort: { _id: 1 }, limit: batchSize },
      )
      .toArray();
    const last = batch.at(-1);
    if (last === undefined) return removed;
    const alive = await tasks
      .find({ _id: { $in: batch.map(taskIdOf) } }, { projection: { _id: 1 } })
      .toArray();
    const kept = new Set(alive.map((task) => task._id));
    const orphans = batch.filter((message) => !kept.has(taskIdOf(message)));
    // each row is re-checked in the delete itself, as `sweptTerminalBefore` does: a second sweep may
    // have removed the orphan and a resend created a new task's message under the same `_id` since
    // this one read it — that message has another `taskId` and a `savedAt` past the cutoff, and stays
    if (orphans.length > 0)
      removed += (
        await messages.deleteMany({
          $or: orphans.map(({ _id, taskId }) => ({ _id, taskId, savedAt: { $lt: cutoff } })),
        })
      ).deletedCount;
    after = last._id;
  }
}
