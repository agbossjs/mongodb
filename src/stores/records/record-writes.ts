import { randomUUID } from "node:crypto";
import type {
  ExecutionRecordStatus,
  NewTurn,
  PauseAnswerRecord,
  Turn,
  TurnOutcome,
} from "@agboss/core";
import type { ClientSession, Db } from "mongodb";
import { assertPauseAnswerInstants, StoreError, type StatusContext } from "@agboss/core/stores";
import type { MongoConnection } from "../../connection/mongodb-connection.js";
import { appendRecordStatus } from "../status-log.js";
import { threadsOf } from "./record-threads.js";
import { z } from "zod";
import { Collections } from "../../connection/collections.js";
import { idOf } from "../keys.js";
import { nextSequence } from "../sequence.js";
import type { RecordDocument } from "./record-documents.js";

/** Threads, appended records, their completion (unconditional or compare-and-set) and the pause log. */

const PauseAnswerText = z.object({ record: z.string(), askedAt: z.date() });
const ThreadOf = z.object({ tenantId: z.string(), threadId: z.string() });

/**
 * A write to a thread's record is its activity (what a memory's `ttl` counts from, #1303), and
 * locks the thread's document for the transaction: a sweep of the thread conflicts with it.
 */
async function touched(
  db: Db,
  session: ClientSession,
  thread: { readonly tenantId: string; readonly threadId: string },
  now: Date,
): Promise<boolean> {
  const done = await threadsOf(db).updateOne(
    { _id: idOf(thread.tenantId, thread.threadId), isSwept: false },
    { $set: { lastActiveAt: now } },
    { session },
  );
  return done.matchedCount === 1;
}

/**
 * Appends a record in one transaction with its thread's activity and its status-history document
 * (#1341d): a new id, the `Clock`'s time, its place the next number of the records' sequence (drawn
 * before the transaction). A swept thread (#1303c) takes no record until its owner creates it again.
 */
export async function appendRecord(
  connection: MongoConnection,
  record: NewTurn,
  write: { readonly now: Date; readonly context?: StatusContext | undefined },
): Promise<Turn> {
  const { now } = write;
  const stored: Turn = { ...record, id: randomUUID(), createdAt: now.toISOString() };
  const seq = await nextSequence(connection.db, Collections.ExecutionRecords);
  const { id, createdAt, ...fields } = stored;
  await connection.inTransaction(async ({ db, session }) => {
    if (!(await touched(db, session, stored, now)))
      throw new Error("the thread was swept: its owner restarts it by creating it again");
    await db
      .collection<RecordDocument>(Collections.ExecutionRecords)
      .insertOne({ ...fields, _id: id, seq, createdAt: new Date(createdAt) }, { session });
    await appendRecordStatus(db, session, stored, {
      status: stored.status,
      context: write.context,
      at: now,
    });
  });
  return stored;
}

/**
 * Writes the outcome, the thread's activity and its status document in one transaction; with
 * `expected`, only while the record's status is it — one compare-and-set update, atomic.
 */
export function completeRecord(
  connection: MongoConnection,
  id: string,
  outcome: TurnOutcome,
  write: CompleteWrite,
): Promise<boolean> {
  return connection.inTransaction(({ db, session }) =>
    completedIn(db, session, id, outcome, write),
  );
}

/** What a completion writes besides the outcome. */
export interface CompleteWrite {
  readonly now: Date;
  readonly expected?: ExecutionRecordStatus | undefined;
  readonly context?: StatusContext | undefined;
}

/** `completeRecord`'s writes, in the caller's transaction. */
export async function completedIn(
  db: Db,
  session: ClientSession,
  id: string,
  outcome: TurnOutcome,
  write: CompleteWrite,
): Promise<boolean> {
  const { replyWith, status, stopReason, route, steps, costUsd } = outcome;
  // `status: expected` filters only when there is one: the client leaves out an undefined field (`ignoreUndefined`)
  const completed = await db
    .collection<RecordDocument>(Collections.ExecutionRecords)
    .findOneAndUpdate(
      { _id: id, status: write.expected },
      { $set: { replyWith, status, stopReason, route: [...route], steps: [...steps], costUsd } },
      { session, returnDocument: "after", projection: { tenantId: 1, threadId: 1 } },
    );
  if (completed === null) return false;
  const thread = ThreadOf.parse(completed);
  await touched(db, session, thread, write.now);
  await appendRecordStatus(db, session, thread, { status, context: write.context, at: write.now });
  return true;
}

/**
 * Keeps a resolved pause once per step of its tree (a second save is ignored) — `askedAt` a BSON Date
 * (the order `sort({ askedAt: 1, seq: 1 })` is by instant: a text would sort apart from a Date), the
 * entry's JSON canonical ISO texts — by tenant, tree
 * and step key (agbossjs/agboss#676: a step key names no tree, so another tree's pause of the same
 * step key is logged too).
 */
export async function savePauseAnswer(
  db: Db,
  tenantId: string,
  rootExecutionId: string,
  answer: PauseAnswerRecord,
): Promise<void> {
  assertPauseAnswerInstants(answer);
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
  return found.map((one) => {
    const parsed = PauseAnswerText.safeParse(one);
    if (parsed.success) return parsed.data.record;
    // a text where the sort key's BSON Date belongs: refused by the field, never by the value
    throw new StoreError.UnreadableRecord({
      record: "pause answer",
      ids: `tenantId ${tenantId}, rootExecutionId ${rootExecutionId}`,
      fields: parsed.error.issues.map((issue) => issue.path.join(".")).join(", "),
    });
  });
}

/**
 * Writes that a pause's answer was not taken (I12, #938): the entry of the step is set to `answer`
 * (`isTaken: false`) — an upsert that keeps the first entry's `seq` and `askedAt`, so the order
 * `sort({ askedAt: 1, seq: 1 })` holds — and a `savePauseAnswer` that comes after is ignored (it
 * only sets on insert), so in either order the last entry says *not taken* and keeps the answer.
 * `replaceOne` takes no `$` operators and would lose `seq`, hence `$set` + `$setOnInsert`.
 */
export async function markPauseAnswerNotTaken(
  db: Db,
  tenantId: string,
  rootExecutionId: string,
  answer: PauseAnswerRecord,
): Promise<void> {
  assertPauseAnswerInstants(answer);
  const _id = idOf(tenantId, rootExecutionId, answer.step.idempotencyKey);
  const seq = await nextSequence(db, Collections.PauseAnswers);
  const entries = db.collection<{ _id: string }>(Collections.PauseAnswers);
  await entries.updateOne(
    { _id },
    {
      $set: { record: JSON.stringify(answer) },
      $setOnInsert: { tenantId, rootExecutionId, askedAt: answer.askedAt, seq },
    },
    { upsert: true },
  );
}
