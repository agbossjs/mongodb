import { InterruptMode } from "@agboss/core";
import { cancelFencedOf, cancelTreeOf, pauseFencedOf, stopFencedOf, type EffectKey } from "@agboss/core/stores";
import type { ClientSession, Db } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";
import { treeIdOf } from "./keys.js";
import type { LeaseDocument } from "./lease-documents.js";
import { TokenFields, tokenOf } from "./lease-documents.js";
import { orSeed, seedStages, type Tree } from "./lease-seed.js";
import { logged, type MarkScope, type MarkWrite } from "./lease-marks.js";
import { storeNowOf } from "./store-time.js";

/**
 * The cancel as a fence on MongoDB (agbossjs/agboss#909, #1117): a tree's durable cancel request is
 * the field `cancelRequestedAt` of the tree's own lease document `(tenantId, rootExecutionId)` —
 * permanent: every write of the document keeps it (`acquire` is an update of the stored document,
 * never a replacement), no retention, release, retire, take or takeover removes it, and no update
 * unsets it. A cancel before the tree's first `acquire` upserts a **seed document** (`lease-seed.ts`).
 *
 * A read inside a MongoDB transaction does not lock (`fence.ts`), so the check **writes** the
 * root's document first (`fenceChecks` counted up — a real change every time, never a no-op the
 * server skips without locking) and reads the marks after. Every mark (`requestCancel`,
 * `requestStop`, `requestPause`: `lease-marks.ts`) is one single-document update outside a
 * transaction or in the mark's own: it waits for a transaction that already wrote the document, or
 * it commits first and the transaction's later write is a `WriteConflict` — a
 * `TransientTransactionError`, so the driver runs the transaction again on a snapshot that holds
 * the mark. For a root's or a `SameInstance` key the document is the lease `checkFence` already
 * wrote; for a child's key it is its root's, seeded here when absent so that a document always
 * exists to conflict on.
 */

const leasesOf = (db: Db) => db.collection<LeaseDocument>(Collections.ExecutionLeases);

const Request = z.object({ cancelRequestedAt: z.date().optional() });

/**
 * Marks the tree's cancel at the store's now: once — a repeat keeps the first `cancelRequestedAt`,
 * which nothing ever unsets. One update that answers the document as it was: the history document
 * (#1341d), in the caller's transaction, is written only when this call set the mark.
 */
export async function markCancel(scope: MarkScope, tree: Tree, write: MarkWrite): Promise<void> {
  const before = await leasesOf(scope.db).findOneAndUpdate(
    { _id: treeIdOf(tree.tenantId, tree.rootExecutionId) },
    [
      ...seedStages(tree),
      { $set: { cancelRequestedAt: orSeed("cancelRequestedAt", storeNowOf(write.clock)) } },
    ],
    {
      upsert: true,
      returnDocument: "before",
      ...(scope.session === undefined ? {} : { session: scope.session }),
    },
  );
  if (Request.parse(before ?? {}).cancelRequestedAt === undefined) await logged(scope, write);
}

/** What the fences of a write read of its tree's ROOT document. */
const FenceMarks = z.intersection(
  TokenFields,
  z.object({
    cancelRequestedAt: z.date().optional(),
    stopMode: z.enum(InterruptMode).optional(),
    fencedThroughToken: z.number().int().optional(),
  }),
);

/**
 * The tree's fences of a fenced write, in its transaction, after the lease and the mark and — for
 * an effect — the key's lookup, all on the tree's ROOT document (locked by a write, so a child's
 * key is checked against its root): a pause fenced the root lease through a token (#1341c) — a
 * write of the root's lease at or below it is stale, and so is a child's while the root's current
 * token is the fenced one → `ExecutionPauseFencedError`; an `Immediate` stop with no cancel
 * (#1341b) → `ExecutionStopFencedError`; a cancel request and a key that is not an undo's →
 * `ExecutionError.CancelFenced`. Nothing written or sent.
 */
export async function checkCancel(db: Db, session: ClientSession, key: EffectKey): Promise<void> {
  const tree = cancelTreeOf(key);
  const filter = { _id: treeIdOf(tree.tenantId, tree.rootExecutionId) };
  // a root's or a SameInstance key's lease document is the one `checkFence` just wrote in this transaction
  if (tree.rootExecutionId !== key.leaseExecutionId)
    await leasesOf(db).updateOne(
      filter,
      [
        ...seedStages(tree),
        { $set: { fenceChecks: { $add: [{ $ifNull: ["$fenceChecks", 0] }, 1] } } },
      ],
      { upsert: true, session },
    );
  const row = FenceMarks.parse(await leasesOf(db).findOne(filter, { session }));
  const fenced = row.fencedThroughToken;
  if (fenced !== undefined) {
    const isStale =
      key.leaseExecutionId === tree.rootExecutionId ? key.token <= fenced : fenced >= tokenOf(row);
    if (isStale) throw pauseFencedOf(key);
  }
  const isCancelled = row.cancelRequestedAt !== undefined;
  if (!isCancelled && row.stopMode === InterruptMode.Immediate) throw stopFencedOf(key);
  if (key.isCompensation === true) return;
  if (isCancelled) throw cancelFencedOf(key);
}
