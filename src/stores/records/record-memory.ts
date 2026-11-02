import { randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";
import { z } from "zod";
import { Collections } from "../../connection/collections.js";
import {
  oldestFirst,
  seqOf,
  type NewSummaryRecord,
  type StoredRecord,
  type StoredSummary,
} from "./record-documents.js";
import { newest, oldest } from "./record-reads.js";

/**
 * Conversation memory on the records (#77, #120 PR 3): the turns a compaction has not summarised,
 * the turns before one, a turn's position, and each compaction's summaries of a thread — a turn's
 * place is its record's `seq`.
 */

interface SummaryDocument extends Omit<StoredSummary, "id" | "createdAt"> {
  _id: string;
  fromSeq: number | null;
  toSeq: number | null;
  createdAt: Date;
}

const StoredSummaryDocument = z.object({
  _id: z.string(),
  tenantId: z.string(),
  threadId: z.string(),
  bundle: z.string(),
  compaction: z.string(),
  fromTernId: z.string(),
  toTernId: z.string(),
  turns: z.number(),
  text: z.string(),
  costUsd: z.number(),
  createdAt: z.date(),
});

const summaryOf = (found: unknown): StoredSummary => {
  const { _id, createdAt, ...summary } = StoredSummaryDocument.parse(found);
  return { ...summary, id: _id, createdAt: createdAt.toISOString() };
};

const summariesIn = (db: Db): Collection<SummaryDocument> =>
  db.collection<SummaryDocument>(Collections.ExecutionSummaries);

const LastSeq = z.object({ toSeq: z.number().nullable() });

/** The thread's records after the compaction's last summary, oldest first. */
export async function uncoveredRecords(
  db: Db,
  tenantId: string,
  threadId: string,
  compaction: string,
): Promise<StoredRecord[]> {
  const last = await summariesIn(db).findOne(
    { tenantId, threadId, compaction, toSeq: { $ne: null } },
    { sort: { toSeq: -1 } },
  );
  const after = last === null ? 0 : (LastSeq.parse(last).toSeq ?? 0);
  return oldest(db, { tenantId, threadId, seq: { $gt: after } });
}

/** Up to `limit` records of the thread right before `recordId`, oldest first. */
export async function recordsBefore(
  db: Db,
  tenantId: string,
  threadId: string,
  recordId: string,
  limit: number,
): Promise<StoredRecord[]> {
  const before = await seqOf(db, recordId);
  if (before === undefined) return [];
  return newest(db, { tenantId, threadId, seq: { $lt: before } }, limit);
}

/** The 1-based position of a record in its thread (0 for an unknown record). */
export async function turnNumberOf(
  db: Db,
  tenantId: string,
  threadId: string,
  recordId: string,
): Promise<number> {
  const at = await seqOf(db, recordId);
  if (at === undefined) return 0;
  return db
    .collection(Collections.ExecutionRecords)
    .countDocuments({ tenantId, threadId, seq: { $lte: at } });
}

/** Adds a summary of a run of turns: its bounds kept as their records' `seq`. */
export async function addSummary(
  db: Db,
  summary: NewSummaryRecord,
  now: Date,
): Promise<StoredSummary> {
  const stored: StoredSummary = { ...summary, id: randomUUID(), createdAt: now.toISOString() };
  const [fromSeq, toSeq] = await Promise.all([
    seqOf(db, summary.fromTernId),
    seqOf(db, summary.toTernId),
  ]);
  const { id, createdAt, ...fields } = stored;
  await summariesIn(db).insertOne({
    ...fields,
    _id: id,
    fromSeq: fromSeq ?? null,
    toSeq: toSeq ?? null,
    createdAt: new Date(createdAt),
  });
  return stored;
}

/** The compaction's newest `limit` summaries of the thread, oldest first. */
export async function latestSummariesOf(
  db: Db,
  tenantId: string,
  threadId: string,
  compaction: string,
  limit: number,
): Promise<StoredSummary[]> {
  if (limit <= 0) return [];
  const found = await summariesIn(db)
    .find({ tenantId, threadId, compaction })
    .sort({ toSeq: -1 })
    .limit(limit)
    .toArray();
  return oldestFirst(found).map(summaryOf);
}

/** How many summaries the compaction keeps of the thread. */
export const summaryCountOf = (
  db: Db,
  tenantId: string,
  threadId: string,
  compaction: string,
): Promise<number> => summariesIn(db).countDocuments({ tenantId, threadId, compaction });
