import type { ExecutionRecordStatus } from "@agboss/core";
import type { Collection, Db, Filter } from "mongodb";
import { Collections } from "../../connection/collections.js";
import {
  oldestFirst,
  recordsOf,
  seqOf,
  type RecordDocument,
  type StoredRecord,
} from "./record-documents.js";

/** The reads of records: by thread, by id, by status (recovery), by prompt version. Oldest first. */

const recordsIn = (db: Db): Collection<RecordDocument> =>
  db.collection<RecordDocument>(Collections.ExecutionRecords);

/** The records `filter` matches, oldest first, at most `limit` (none for 0). */
async function oldest(
  db: Db,
  filter: Filter<RecordDocument>,
  limit?: number,
): Promise<StoredRecord[]> {
  if (limit === 0) return [];
  const cursor = recordsIn(db).find(filter).sort({ seq: 1 });
  return recordsOf(await (limit === undefined ? cursor : cursor.limit(limit)).toArray());
}

/** The newest `limit` records `filter` matches, oldest first. */
export async function newest(
  db: Db,
  filter: Filter<RecordDocument>,
  limit: number,
): Promise<StoredRecord[]> {
  if (limit <= 0) return [];
  const found = await recordsIn(db).find(filter).sort({ seq: -1 }).limit(limit).toArray();
  return recordsOf(oldestFirst(found));
}

export { oldest };

/** The newest `limit` records of a thread, oldest first. */
export const lastRecordsOf = (
  db: Db,
  tenantId: string,
  threadId: string,
  limit: number,
): Promise<StoredRecord[]> => newest(db, { tenantId, threadId }, limit);

/** The records of `ids`, in the order they were appended. */
export const recordsByIds = (db: Db, ids: readonly string[]): Promise<StoredRecord[]> =>
  oldest(db, { _id: { $in: [...ids] } });

/** A page of the records with `status` after the record `after` (recovery's look-up, #265 S30). */
export async function recordsByStatus(
  db: Db,
  status: ExecutionRecordStatus,
  limit: number,
  after: string | undefined,
): Promise<StoredRecord[]> {
  const from = after === undefined ? 0 : ((await seqOf(db, after)) ?? 0);
  return oldest(db, { status, seq: { $gt: from } }, limit);
}

/** Original (not replayed) records of a prompt version, a run in flight left out. */
export const recordsByVersion = (
  db: Db,
  workflow: string,
  promptVersion: string,
  limit: number,
): Promise<StoredRecord[]> =>
  oldest(
    db,
    { bundle: workflow, promptVersion, replayOf: null, status: { $ne: "running" } },
    limit,
  );

/** Answered records without a score, of one prompt version or of all. */
export async function unscoredRecords(
  db: Db,
  workflow: string,
  promptVersion: string | undefined,
  limit: number,
): Promise<StoredRecord[]> {
  if (limit <= 0) return [];
  const found = await recordsIn(db)
    .aggregate([
      {
        $match: {
          bundle: workflow,
          status: "answered",
          ...(promptVersion === undefined ? {} : { promptVersion }),
        },
      },
      { $sort: { seq: 1 } },
      {
        $lookup: {
          from: Collections.ExecutionScores,
          localField: "_id",
          foreignField: "recordId",
          as: "scores",
        },
      },
      { $match: { scores: { $size: 0 } } },
      { $limit: limit },
    ])
    .toArray();
  return recordsOf(found);
}

/** The newest `limit` original answered records of a workflow, oldest first. */
export const recentOriginalRecords = (
  db: Db,
  workflow: string,
  limit: number,
): Promise<StoredRecord[]> =>
  newest(db, { bundle: workflow, replayOf: null, status: "answered" }, limit);
