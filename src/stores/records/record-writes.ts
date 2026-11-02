import { randomUUID } from "node:crypto";
import type { ExecutionRecordStatus } from "@agboss/core";
import type { Db } from "mongodb";
import { z } from "zod";
import { Collections } from "../../connection/collections.js";
import { DUPLICATE_KEY, hasCode, idOf } from "../keys.js";
import { nextSequence } from "../sequence.js";
import type {
  NewRecord,
  NewThreadRecord,
  PauseAnswer,
  RecordDocument,
  RecordOutcome,
  StoredRecord,
} from "./record-documents.js";

/** Threads, appended records, their completion (unconditional or compare-and-set) and the pause log. */

interface ThreadDocument {
  _id: string;
  tenantId: string;
  threadId: string;
  workflow: string;
  owner: string | null;
  createdAt: Date;
}

const Owner = z.object({ owner: z.string().nullable() });
const PauseAnswerText = z.object({ record: z.string() });

/**
 * A new thread: `true` when this insert made it, `false` when the tenant has the id already — the
 * first insert keeps it (and its owner), its `_id` unique.
 */
export async function createThread(
  db: Db,
  thread: NewThreadRecord,
  id: string,
  now: Date,
): Promise<boolean> {
  try {
    await db.collection<ThreadDocument>(Collections.Threads).insertOne({
      _id: idOf(thread.tenantId, id),
      tenantId: thread.tenantId,
      threadId: id,
      workflow: thread.workflow,
      owner: thread.ownerId ?? null,
      createdAt: now,
    });
    return true;
  } catch (error) {
    if (hasCode(error, DUPLICATE_KEY)) return false;
    throw error;
  }
}

/** The thread's owner (`owner: undefined`: created without one); `undefined` when there is no such thread. */
export async function threadOwnerOf(
  db: Db,
  workflow: string,
  tenantId: string,
  threadId: string,
): Promise<{ readonly owner: string | undefined } | undefined> {
  const found = await db
    .collection<ThreadDocument>(Collections.Threads)
    .findOne({ _id: idOf(tenantId, threadId), workflow });
  if (found === null) return undefined;
  return { owner: Owner.parse(found).owner ?? undefined };
}

/** Appends a record: a new id, the `Clock`'s time, its place the next number of the records' sequence. */
export async function appendRecord(db: Db, record: NewRecord, now: Date): Promise<StoredRecord> {
  const stored: StoredRecord = { ...record, id: randomUUID(), createdAt: now.toISOString() };
  const seq = await nextSequence(db, Collections.ExecutionRecords);
  const { id, createdAt, ...fields } = stored;
  await db
    .collection<RecordDocument>(Collections.ExecutionRecords)
    .insertOne({ ...fields, _id: id, seq, createdAt: new Date(createdAt) });
  return stored;
}

/** Writes the outcome; with `expected`, only while the record's status is it — one update, atomic. */
export async function completeRecord(
  db: Db,
  id: string,
  outcome: RecordOutcome,
  expected?: ExecutionRecordStatus,
): Promise<boolean> {
  const { replyWith, status, stopReason, route, steps, costUsd } = outcome;
  const completed = await db
    .collection<RecordDocument>(Collections.ExecutionRecords)
    .updateOne(
      { _id: id, ...(expected === undefined ? {} : { status: expected }) },
      { $set: { replyWith, status, stopReason, route: [...route], steps: [...steps], costUsd } },
    );
  return completed.matchedCount === 1;
}

/**
 * Keeps a resolved pause once per step of its tree (a second save is ignored) — by tenant, tree
 * and step key (agbossjs/agboss#676: a step key names no tree, so another tree's pause of the same
 * step key is logged too).
 */
export async function savePauseAnswer(
  db: Db,
  tenantId: string,
  rootExecutionId: string,
  answer: PauseAnswer,
): Promise<void> {
  const _id = idOf(tenantId, rootExecutionId, answer.step.idempotencyKey);
  const seq = await nextSequence(db, Collections.PauseAnswers);
  const document = {
    _id,
    tenantId,
    rootExecutionId,
    askedAt: answer.askedAt,
    seq,
    record: JSON.stringify(answer),
  };
  await db
    .collection<typeof document>(Collections.PauseAnswers)
    .updateOne({ _id }, { $setOnInsert: document }, { upsert: true });
}

/** The stored JSON of a tree's resolved pauses, in the order asked (ties in the order kept). */
export async function pauseAnswerTextsOf(
  db: Db,
  tenantId: string,
  rootExecutionId: string,
): Promise<readonly string[]> {
  const found = await db
    .collection(Collections.PauseAnswers)
    .find({ tenantId, rootExecutionId })
    .sort({ askedAt: 1, seq: 1 })
    .toArray();
  return found.map((one) => PauseAnswerText.parse(one).record);
}
