import { OutboundCallLeaseState, type OutboundCallLease, type StoreClock } from "@agboss/core";
import type { ClientSession, Db } from "mongodb";
import { Collections } from "../../connection/collections.js";
import { lockedLeaseOf } from "../fence.js";
import { treeIdOf } from "../keys.js";

/**
 * `MongoOutboundCallRepository.leaseStateOf` (agbossjs/agboss#508), in the caller's transaction:
 * the lease document locked by a write and read (`lockedLeaseOf`: a renewal, a yield, a reclaim or
 * a take of it either committed before — and is what is read — or waits for this transaction),
 * then, for one expired by the store's time at the token, the close: released and `superseded`,
 * so its holder can neither renew, yield, reclaim nor write under it again, and the next take names
 * it as `takenOverFrom`. A late renewal and the close never both win.
 */
export async function leaseStateIn(
  db: Db,
  session: ClientSession,
  lease: OutboundCallLease,
  clock: StoreClock,
): Promise<OutboundCallLeaseState> {
  const { tenantId, leaseExecutionId, token } = lease;
  const found = await lockedLeaseOf(db, session, tenantId, leaseExecutionId, clock);
  if (found === undefined || found.released || found.leaseEpoch !== token)
    return OutboundCallLeaseState.Ended;
  // live while expiresAt > now, by the store's time of the lock (#534, #533)
  if (found.expiresAt.getTime() > found.checkedAt.getTime()) return OutboundCallLeaseState.Live;
  await db
    .collection<{ _id: string }>(Collections.ExecutionLeases)
    .updateOne(
      { _id: treeIdOf(tenantId, leaseExecutionId) },
      { $set: { released: true, superseded: true } },
      { session },
    );
  return OutboundCallLeaseState.Superseded;
}
