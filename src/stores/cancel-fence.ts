import { ExecutionCancelFencedError, cancelTreeOf, type EffectKey } from "@agboss/core/stores";
import type { StoreClock } from "@agboss/core";
import type { ClientSession, Db, Document } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";
import { treeIdOf } from "./keys.js";
import { STORED_TOKEN, DROP_OLD_NAMES, type LeaseDocument } from "./lease-documents.js";
import { literal, storeNowOf } from "./store-time.js";

/**
 * The cancel as a fence on MongoDB (agbossjs/agboss#909, #1117): a tree's durable cancel request is
 * the field `cancelRequestedAt` of the tree's own lease document `(tenantId, rootExecutionId)` —
 * permanent: every write of the document keeps it (`acquire` is an update of the stored document,
 * never a replacement), no retention removes it. A cancel before the tree's first `acquire` upserts
 * a **seed document**: token 0, released, empty holder, never held, so that acquire is token 1 with
 * no takeover.
 *
 * A read inside a MongoDB transaction does not lock (`fence.ts`), so the check **writes** the
 * root's document first (`fenceChecks` counted up — a real change every time, never a no-op the
 * server skips without locking) and reads the mark after. `requestCancel` is one single-document
 * command outside any transaction: it waits for a transaction that already wrote the document, or
 * it commits first and the transaction's later write is a `WriteConflict` — a
 * `TransientTransactionError`, so the driver runs the transaction again on a snapshot that holds
 * the mark. For a root's or a `SameInstance` key the document is the lease `checkFence` already
 * wrote; for a child's key it is its root's, seeded here when absent so that a document always
 * exists to conflict on.
 */

const Request = z.object({ cancelRequestedAt: z.date().optional() });

/** The tree's tenant and root: the key of the lease document that carries its mark. */
interface Tree {
  readonly tenantId: string;
  readonly rootExecutionId: string;
}

const leasesOf = (db: Db) => db.collection<LeaseDocument>(Collections.ExecutionLeases);

/** A field of the seed: kept when the document has it, else the seed's value (an update pipeline's `$setOnInsert`). */
const orSeed = (field: string, seed: unknown): Document => ({ $ifNull: [`$${field}`, seed] });

/**
 * The stage that makes a document of the tree where there is none — token 0, released, empty
 * holder, expired at the epoch — and changes nothing of one that is there (its token, holder,
 * flags stay; a 0.1.0 document's `leaseEpoch` is read as its token and renamed, as every write does).
 */
function seedStages(tree: Tree): Document[] {
  return [
    {
      $set: {
        tenantId: orSeed("tenantId", literal(tree.tenantId)),
        rootExecutionId: orSeed("rootExecutionId", literal(tree.rootExecutionId)),
        holderInstanceId: orSeed("holderInstanceId", literal("")),
        token: { $ifNull: [STORED_TOKEN, 0] },
        expiresAt: orSeed("expiresAt", new Date(0)),
        released: orSeed("released", true),
        yielded: orSeed("yielded", false),
        superseded: orSeed("superseded", false),
        finished: orSeed("finished", false),
      },
    },
    DROP_OLD_NAMES,
  ];
}

/** Marks the tree's cancel at the store's now: once — a repeat keeps the first `cancelRequestedAt`. */
export async function markCancel(db: Db, tree: Tree, clock: StoreClock): Promise<void> {
  await leasesOf(db).updateOne(
    { _id: treeIdOf(tree.tenantId, tree.rootExecutionId) },
    [
      ...seedStages(tree),
      { $set: { cancelRequestedAt: orSeed("cancelRequestedAt", storeNowOf(clock)) } },
    ],
    { upsert: true },
  );
}

/**
 * The cancel check of a fenced write, in its transaction, after the lease and the scope's mark and
 * — for an effect — the key's lookup: the key's tree has a cancel mark on its root's lease document
 * and the key is not an undo's → `ExecutionCancelFencedError`, nothing written or sent.
 */
export async function checkCancel(db: Db, session: ClientSession, key: EffectKey): Promise<void> {
  if (key.isCompensation === true) return;
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
  const found = Request.parse(await leasesOf(db).findOne(filter, { session }));
  if (found.cancelRequestedAt !== undefined) throw ExecutionCancelFencedError.of(key);
}
