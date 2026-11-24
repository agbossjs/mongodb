import type { ClientSession, Collection, Db } from "mongodb";
import { z } from "zod";
import { Collections } from "../../connection/collections.js";
import type { MongoConnection } from "../../connection/mongodb-connection.js";
import { idOf } from "../keys.js";
import { forgottenStatus } from "../status-log.js";
import type { RecordDocument } from "./record-documents.js";
import { threadsOf, type ThreadDocument } from "./record-threads.js";

/**
 * The sweep of idle threads (agbossjs/agboss#1303c) on MongoDB: a thread whose memory's `ttl` ran
 * out since its last activity is emptied of its records, summaries, scores, pause answers and status
 * history — never while a tree of it is live or paused. An owned thread stays as a tombstone
 * (`isSwept`): no other owner can take the id; the owner may restart on it. A thread with no owner
 * goes whole. Each thread is decided on its own, in one transaction, so one that came back to life
 * keeps its documents: the removal first WRITES the thread's document (`sweepChecks`, which locks it
 * — a read in a transaction does not), so a record appended meanwhile (which touches the same
 * document) either committed before — and is read by the checks — or conflicts with this transaction.
 */

/** How many threads of one workflow one look removes: the rest go at the next look. */
const THREADS_PER_LOOK = 100;

/** The statuses of a record whose execution may still move: its thread is never removed. */
const LIVE_STATUSES = ["running", "paused", "queued"] as const;

interface IdleThread {
  readonly tenantId: string;
  readonly threadId: string;
}

/** Whether a tree has ended: asked once per run of a thread. */
export type IsRunEnded = (tree: {
  readonly tenantId: string;
  readonly rootExecutionId: string;
}) => Promise<boolean>;

const ThreadKey = z.object({ tenantId: z.string(), threadId: z.string() });

async function idleThreadsOf(db: Db, workflow: string, cutoff: Date): Promise<IdleThread[]> {
  const found = await threadsOf(db)
    .find(
      { workflow, isSwept: false, lastActiveAt: { $lt: cutoff } },
      { projection: { tenantId: 1, threadId: 1 } },
    )
    .sort({ lastActiveAt: 1 })
    .limit(THREADS_PER_LOOK)
    .toArray();
  return found.map((one) => ThreadKey.parse(one));
}

async function runsOf(db: Db, thread: IdleThread): Promise<readonly string[]> {
  const runs: unknown[] = await db
    .collection<RecordDocument>(Collections.ExecutionRecords)
    .distinct("runId", { tenantId: thread.tenantId, threadId: thread.threadId });
  return runs.filter((run): run is string => typeof run === "string");
}

/** The thread's documents in every collection, children first, in the caller's transaction. */
async function deleteRowsOf(
  db: Db,
  session: ClientSession,
  thread: IdleThread,
  runs: readonly string[],
): Promise<void> {
  const { tenantId, threadId } = thread;
  const _id = idOf(tenantId, threadId);
  const records: Collection<RecordDocument> = db.collection(Collections.ExecutionRecords);
  const ids = await records.distinct("_id", { tenantId, threadId }, { session });
  await forgottenStatus(db, thread, session);
  await db
    .collection(Collections.ExecutionScores)
    .deleteMany({ recordId: { $in: ids } }, { session });
  await db
    .collection(Collections.PauseAnswers)
    .deleteMany({ tenantId, rootExecutionId: { $in: [...runs] } }, { session });
  await db
    .collection(Collections.ExecutionSummaries)
    .deleteMany({ tenantId, threadId }, { session });
  await records.deleteMany({ tenantId, threadId }, { session });
  // a thread with an owner stays as a tombstone; one with none goes whole
  const kept = await threadsOf(db).updateOne(
    { _id, owner: { $ne: null } },
    { $set: { isSwept: true } },
    { session },
  );
  if (kept.matchedCount === 0) await threadsOf(db).deleteOne({ _id }, { session });
}

/** Removes the thread in one transaction — only if it is still idle, with no live record and no run beyond `runs`. */
async function removeThread(
  connection: MongoConnection,
  thread: IdleThread,
  options: { readonly workflow: string; readonly cutoff: Date; readonly runs: readonly string[] },
): Promise<boolean> {
  return connection.inTransaction(async ({ db, session }) => {
    const { tenantId, threadId } = thread;
    const _id = idOf(tenantId, threadId);
    const records: Collection<RecordDocument> = db.collection(Collections.ExecutionRecords);
    // the write locks the document: the decision below is made on a thread no append can change
    const checked = await db
      .collection<ThreadDocument & { sweepChecks?: number }>(Collections.Threads)
      .updateOne(
        {
          _id,
          workflow: options.workflow,
          isSwept: false,
          lastActiveAt: { $lt: options.cutoff },
        },
        { $inc: { sweepChecks: 1 } },
        { session },
      );
    if (checked.matchedCount === 0) return false;
    const isLive = await records.countDocuments(
      { tenantId, threadId, status: { $in: [...LIVE_STATUSES] } },
      { session, limit: 1 },
    );
    if (isLive > 0) return false;
    const hasOtherRun = await records.countDocuments(
      { tenantId, threadId, runId: { $nin: [null, ...options.runs] } },
      { session, limit: 1 },
    );
    if (hasOtherRun > 0) return false;
    await deleteRowsOf(db, session, thread, options.runs);
    return true;
  });
}

/** Whether every run of the thread ended: asked once each; a live or unknown one keeps the thread. */
async function isThreadEnded(
  runs: readonly string[],
  tenantId: string,
  isEnded: IsRunEnded,
): Promise<boolean> {
  for (const runId of runs)
    if (!(await isEnded({ tenantId, rootExecutionId: runId }))) return false;
  return true;
}

/** The sweep of `@Memory({ ttl })`: how many threads went. */
export async function deleteIdleThreads(
  connection: MongoConnection,
  cutoffs: ReadonlyMap<string, Date>,
  isEnded: IsRunEnded,
): Promise<number> {
  const { db } = connection;
  let removed = 0;
  for (const [workflow, cutoff] of cutoffs)
    for (const thread of await idleThreadsOf(db, workflow, cutoff)) {
      const runs = await runsOf(db, thread);
      if (!(await isThreadEnded(runs, thread.tenantId, isEnded))) continue;
      if (await removeThread(connection, thread, { workflow, cutoff, runs })) removed += 1;
    }
  return removed;
}
