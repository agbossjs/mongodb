import { PauseStatus, type PauseRecord } from "@agboss/core";
import type { PauseFilter, PausePage, PauseScanAfter } from "@agboss/core/stores";
import type { ClientSession, Db, Filter } from "mongodb";
import { Collections } from "../../connection/collections.js";
import { pauseIdOf, pauseOfDocument, type PauseDocument } from "./pause-documents.js";
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
  return pageFrom(found, limit);
}

/** The first `limit` of `found` (read with one more), and the cursor after them when the extra one is there. */
function pageFrom(found: readonly PauseDocument[], limit: number): PausePage {
  const last = found.length > limit ? found.at(limit - 1) : undefined;
  return {
    pauses: found.slice(0, limit).map(pauseOfDocument),
    ...(last === undefined ? {} : { next: String(last.seq) }),
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

/**
 * What lies past `after` in the scan's order `(field, tenantId, pauseId)` (#942, #1070): the keyset,
 * so pauses nobody can move are passed and never read again within one sweep.
 */
function pastKeyset(
  field: "expiresAt" | "remindAt" | "askedAt",
  after: PauseScanAfter | undefined,
): Filter<PauseDocument> {
  if (after === undefined) return {};
  const time = new Date(after.at);
  if (Number.isNaN(time.getTime()))
    throw new TypeError(
      `a pause scan's cursor is an ISO 8601 time, not ${JSON.stringify(after.at)}`,
    );
  const { tenantId, pauseId } = after;
  return {
    $or: [
      { [field]: { $gt: time } },
      { [field]: time, tenantId: { $gt: tenantId } },
      { [field]: time, tenantId, pauseId: { $gt: pauseId } },
    ],
  };
}

/**
 * The pauses whose deadline field `field` is a date at or before `at`, ascending by it, tenant and
 * id, past the keyset `after` when given.
 */
export async function dueBy(
  db: Db,
  field: "expiresAt" | "remindAt",
  at: Date,
  limit: number,
  after?: PauseScanAfter,
): Promise<PauseRecord[]> {
  const found = await db
    .collection<PauseDocument>(Collections.Pauses)
    .find({
      status: PauseStatus.Pending,
      [field]: { $lte: at, $type: "date" },
      ...pastKeyset(field, after),
    })
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
  removedByThisSweep: ReadonlySet<string> = new Set(),
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
    // a reassigned pause is kept while its replacement is stored: the step's interrupt names the
    // first pause of the chain, and its re-entry finds the chain by the step key (#946)
    for (const one of await withStoredReplacement(db, batch, session, removedByThisSweep))
      kept.add(`${one.tenantId}\0${one.pauseId}`);
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
  return pageFrom(await removableBefore(db, cutoff, limit + 1, undefined, after), limit);
}

/**
 * The replacements a reassignment made that are still pending and unsent, made before `cutoff`, in
 * the order `(askedAt, tenantId, pauseId)` past the keyset `after` (#946): the partial index
 * `reassigned_unsent` has that key, so the scan reads it in order.
 */
export async function reassignedUnsentBefore(
  db: Db,
  cutoff: Date,
  limit: number,
  after?: PauseScanAfter,
): Promise<PauseRecord[]> {
  const found = await db
    .collection<PauseDocument>(Collections.Pauses)
    .find({
      status: PauseStatus.Pending,
      isSent: false,
      reassignedFrom: { $exists: true },
      askedAt: { $lt: cutoff },
      ...pastKeyset("askedAt", after),
    })
    .sort({ askedAt: 1, tenantId: 1, pauseId: 1 })
    .limit(limit)
    .toArray();
  return found.map(pauseOfDocument);
}

/** The pauses of `batch` that were reassigned and whose replacement is still stored (#946). */
async function withStoredReplacement(
  db: Db,
  batch: readonly PauseDocument[],
  session: ClientSession | undefined,
  removedByThisSweep: ReadonlySet<string>,
): Promise<PauseDocument[]> {
  const replaced = batch.filter((one) => typeof one.reassignedTo === "string");
  const stored = await db
    .collection<PauseDocument>(Collections.Pauses)
    .find(
      { _id: { $in: replaced.map((one) => pauseIdOf(one.tenantId, String(one.reassignedTo))) } },
      { session, projection: { _id: 1 } },
    )
    .toArray();
  // one removed by this sweep still counts: a chain goes oldest first, one link per sweep
  const ids = new Set([...stored.map((one) => one._id), ...removedByThisSweep]);
  return replaced.filter((one) => ids.has(pauseIdOf(one.tenantId, String(one.reassignedTo))));
}
