import { PauseStatus, type PauseRecord } from "@agboss/core";
import type { PauseFilter, PausePage } from "@agboss/core/stores";
import type { ClientSession, Db, Filter } from "mongodb";
import { Collections } from "../../connection/collections.js";
import { pauseOfDocument, type PauseDocument } from "./pause-documents.js";
import { mailboxesOf } from "./pause-mailboxes.js";

/**
 * What the pause scans share (#938, #910 rules 9, 14): the page size every scan takes, the filter
 * of a tenant's page, and the cursor — the text of the store's insertion sequence (`seq`, drawn from
 * a counter that only grows: a number is never used twice, even after the newest row is deleted),
 * never a position in a list, so a removal between two pages skips nothing.
 */
const MAX_SCAN_LIMIT = 1000;

/** Throws unless `limit` is a whole number from 1 to 1000. */
export function assertScanLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SCAN_LIMIT)
    throw new RangeError(
      `a pause scan's limit is a whole number from 1 to ${String(MAX_SCAN_LIMIT)}, not ${String(limit)}`,
    );
}

/** Throws unless the filter names at least one status. */
export function assertPauseFilter(filter: PauseFilter): void {
  if (filter.statuses.length === 0) throw new TypeError("a pause filter names at least one status");
}

/** The insertion sequence a cursor continues after; no cursor: from the start. */
export function seqOfCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const seq = Number(cursor);
  if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(seq))
    throw new TypeError(`${JSON.stringify(cursor)} is not a pause page cursor`);
  return seq;
}

/** The page of the pauses `filter` selects, in insertion order after `after`, `limit` of them. */
export async function pageOf(
  db: Db,
  filter: Filter<PauseDocument>,
  limit: number,
  after: string | undefined,
): Promise<PausePage> {
  const found = await db
    .collection<PauseDocument>(Collections.Pauses)
    .find({ ...filter, seq: { $gt: seqOfCursor(after) } })
    .sort({ seq: 1 })
    .limit(limit + 1)
    .toArray();
  const page = found.slice(0, limit);
  const last = page.at(-1);
  return {
    pauses: page.map(pauseOfDocument),
    ...(found.length > limit && last !== undefined ? { next: String(last.seq) } : {}),
  };
}

/** What a tenant's page selects. */
export function tenantFilter(tenantId: string, filter: PauseFilter): Filter<PauseDocument> {
  return {
    tenantId,
    status: { $in: [...filter.statuses] },
    ...(filter.channel === undefined ? {} : { channel: filter.channel }),
    ...(filter.expiresBefore === undefined ? {} : { expiresAt: { $lt: filter.expiresBefore } }),
  };
}

/** The pauses whose deadline field `field` is a date at or before `at`, ascending by it, tenant and id. */
export async function dueBy(
  db: Db,
  field: "expiresAt" | "remindAt",
  at: Date,
  limit: number,
): Promise<PauseRecord[]> {
  const found = await db
    .collection<PauseDocument>(Collections.Pauses)
    .find({ status: PauseStatus.Pending, [field]: { $lte: at, $type: "date" } })
    .sort({ [field]: 1, tenantId: 1, pauseId: 1 })
    .limit(limit)
    .toArray();
  return found.map(pauseOfDocument);
}

/**
 * The closed pauses resolved before `cutoff` with no live mailbox, in insertion order after the
 * cursor `after` (its sequence, as the other scans'), `limit` of them.
 */
export async function removableBefore(
  db: Db,
  cutoff: Date,
  limit: number,
  session?: ClientSession,
  after?: string,
): Promise<PauseDocument[]> {
  const pauses = db.collection<PauseDocument>(Collections.Pauses);
  const removable: PauseDocument[] = [];
  let seq = seqOfCursor(after);
  while (removable.length < limit) {
    const batch = await pauses
      .find(
        {
          status: { $in: [PauseStatus.Taken, PauseStatus.Cancelled] },
          resolvedAt: { $lt: cutoff },
          seq: { $gt: seq },
        },
        { session },
      )
      .sort({ seq: 1 })
      .limit(limit)
      .toArray();
    const last = batch.at(-1);
    if (last === undefined) break;
    seq = last.seq;
    const live = await mailboxesOf(db)
      .find(
        {
          pauseId: { $in: batch.map((one) => one.pauseId) },
          isDead: false,
          $expr: { $lt: ["$delivered", { $size: "$notices" }] },
        },
        { session },
      )
      .toArray();
    const kept = new Set(live.map((box) => `${box.tenantId}\0${box.pauseId}`));
    removable.push(...batch.filter((one) => !kept.has(`${one.tenantId}\0${one.pauseId}`)));
  }
  return removable.slice(0, limit);
}

/** A page of what the delete would remove (#939): `limit` of them after `after`, `next` when more follow. */
export async function removablePageBefore(
  db: Db,
  cutoff: Date,
  limit: number,
  after: string | undefined,
): Promise<PausePage> {
  const found = await removableBefore(db, cutoff, limit + 1, undefined, after);
  const page = found.slice(0, limit);
  const last = page.at(-1);
  return {
    pauses: page.map(pauseOfDocument),
    ...(found.length > limit && last !== undefined ? { next: String(last.seq) } : {}),
  };
}
