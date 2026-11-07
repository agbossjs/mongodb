import type { Db } from "mongodb";
import { Collections } from "../../connection/collections.js";
import {
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
