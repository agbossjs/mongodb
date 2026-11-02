import { ExecutionFencedError, type FencedEffectKey, type StoreClock } from "@agboss/core";
import type { ClientSession, Db } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";
import { treeIdOf } from "./keys.js";
import { storeNowOf } from "./store-time.js";

/**
 * The fencing checks of the fenced stores (#500, agbossjs/agboss#505, #508) — the fenced effect and
 * the outbound call — inside the caller's transaction, in the order of #500, after the key's name
 * and business key (each store checks them first with the core's helpers, agbossjs/agboss#526).
 *
 * A read inside a MongoDB transaction does not lock: a takeover committed after the transaction's
 * snapshot would be invisible to it, and the stale holder's write would commit. So the lease check
 * is a **write**: the lease document is touched first (`checkedAt`, the store's time of this
 * check, and `fenceChecks` counted up: a no-op update would lock nothing). From then on a concurrent take, renewal or close of that lease either committed before
 * the touch — and the touch conflicts (`WriteConflict`, a `TransientTransactionError`: the driver
 * runs the transaction again, which reads it) — or waits for this transaction to end. The document
 * read right after is therefore the lease as it is, and `checkedAt` the store's own now: held at
 * the token, not released, live (`expiresAt > checkedAt`, #534). Then the scope's mark is raised to
 * the token (`$max`, a write too); a higher one refuses the key before any of its rows is read.
 */

const CheckedLease = z.object({
  leaseEpoch: z.number().int(),
  expiresAt: z.date(),
  released: z.boolean(),
  checkedAt: z.date(),
});

const Mark = z.object({ highestToken: z.number().int() });

/** The key's lease locked and read in `session`: the lease, `checkedAt` the store's now; none: undefined. */
export async function lockedLeaseOf(
  db: Db,
  session: ClientSession,
  tenantId: string,
  leaseExecutionId: string,
  clock: StoreClock,
): Promise<z.infer<typeof CheckedLease> | undefined> {
  const leases = db.collection<{ _id: string }>(Collections.ExecutionLeases);
  const filter = { _id: treeIdOf(tenantId, leaseExecutionId) };
  // a real change every time — `fenceChecks` counts up —, never a no-op the server would skip
  // without locking (a test's clock sets the same `checkedAt` twice)
  const touched = await leases.updateOne(
    filter,
    [
      {
        $set: {
          checkedAt: storeNowOf(clock),
          fenceChecks: { $add: [{ $ifNull: ["$fenceChecks", 0] }, 1] },
        },
      },
    ],
    { session },
  );
  if (touched.matchedCount === 0) return undefined;
  return CheckedLease.parse(await leases.findOne(filter, { session }));
}

/**
 * The key's lease is held at its token (not released, live by the store's time) and no newer token
 * wrote its scope — else `ExecutionFencedError`; the mark is raised to the token. The lease stays
 * locked until the caller's transaction ends.
 */
export async function checkFence(
  db: Db,
  session: ClientSession,
  key: FencedEffectKey,
  clock: StoreClock,
): Promise<void> {
  const { scopeKey, token } = key;
  const lease = await lockedLeaseOf(db, session, key.tenantId, key.leaseExecutionId, clock);
  const refused = (observedToken: number | undefined): ExecutionFencedError =>
    new ExecutionFencedError({ scopeKey, token, observedToken });
  if (lease === undefined) throw refused(undefined);
  if (lease.released || lease.leaseEpoch !== token) throw refused(lease.leaseEpoch);
  // live while expiresAt > now, by the store's time read in this transaction (#534, #533)
  if (lease.expiresAt.getTime() <= lease.checkedAt.getTime()) throw refused(lease.leaseEpoch);
  const mark = await db
    .collection<{ _id: string; highestToken: number; storedAt: Date }>(
      Collections.FencedEffectMarks,
    )
    .findOneAndUpdate(
      { _id: scopeKey },
      { $max: { highestToken: token }, $set: { storedAt: clock.now() } },
      { upsert: true, returnDocument: "after", session },
    );
  const { highestToken } = Mark.parse(mark);
  if (highestToken > token) throw refused(highestToken);
}

/**
 * Locks the document of a key's identity for the rest of `session`'s transaction (a real write:
 * `$inc`). A business key's row (#508) is one for every scope of its tenant, so no lease lock
 * serializes its writers: this one does — a second transaction on the same key conflicts here,
 * **before** its work runs, and is run again by the driver once the first ended, when it finds the
 * stored row.
 */
export async function lockKey(
  db: Db,
  session: ClientSession,
  identity: string,
  now: Date,
): Promise<void> {
  await db
    .collection<{ _id: string; locks: number; lockedAt: Date }>(Collections.FencedKeyLocks)
    .updateOne(
      { _id: identity },
      { $inc: { locks: 1 }, $set: { lockedAt: now } },
      { upsert: true, session },
    );
}
