import { A2ADirectMessageState, DIRECT_MESSAGE_CLAIM } from "@agboss/core/stores";
import type { ClientSession, Db } from "mongodb";
import { directMessageOf } from "./a2a-direct-message-documents.js";
import { claimsOf, directMessagesOf } from "./a2a-direct-message-save.js";

/**
 * `deleteExpired` of `MongoA2ADirectMessageRepository` (agbossjs/agboss#860, #1320), inside one
 * transaction, bounded by `limit` per endpoint: the oldest `limit` messages of the endpoint whose
 * reply was kept before its `cutoff` (each read through zod first: a corrupt one fails the sweep,
 * never vanishes unread) with their ids' claims, then at most `limit` direct claims (`taskId` `""`)
 * of the endpoint saved before `cutoff` whose message is gone — a failed attempt's. A claim whose document a save inserts meanwhile conflicts with this removal
 * (the save writes its claim: `a2a-direct-message-save.ts`); a task's claim is never touched.
 */

/** The direct claims saved before `cutoff` with no message of theirs: at most `limit`, oldest first. */
async function orphanClaimsIn(
  db: Db,
  session: ClientSession,
  endpoint: string,
  cutoff: Date,
  limit: number,
): Promise<string[]> {
  const old = await claimsOf(db)
    .find(
      { endpoint, taskId: DIRECT_MESSAGE_CLAIM, savedAt: { $lt: cutoff } },
      { session, projection: { _id: 1 }, sort: { savedAt: 1, _id: 1 }, limit },
    )
    .toArray();
  const ids = old.map((claim) => claim._id);
  const held = await directMessagesOf(db)
    .find({ _id: { $in: ids } }, { session, projection: { _id: 1 } })
    .toArray();
  const heldIds = new Set(held.map((message) => message._id));
  return ids.filter((id) => !heldIds.has(id));
}

/** One endpoint's part of the sweep, inside its transaction: how many messages it removed. */
async function sweptEndpointIn(
  db: Db,
  session: ClientSession,
  endpoint: string,
  cutoff: Date,
  limit: number,
): Promise<number> {
  const due = await directMessagesOf(db)
    .find(
      { endpoint, state: A2ADirectMessageState.Completed, completedAt: { $lt: cutoff } },
      { session, sort: { completedAt: 1, _id: 1 }, limit },
    )
    .toArray();
  due.forEach(directMessageOf);
  const ids = due.map((message) => message._id);
  if (ids.length > 0) {
    await directMessagesOf(db).deleteMany(
      { _id: { $in: ids }, state: A2ADirectMessageState.Completed },
      { session },
    );
    await claimsOf(db).deleteMany({ _id: { $in: ids }, taskId: DIRECT_MESSAGE_CLAIM }, { session });
  }
  const orphans = await orphanClaimsIn(db, session, endpoint, cutoff, limit);
  if (orphans.length > 0)
    await claimsOf(db).deleteMany(
      { _id: { $in: orphans }, taskId: DIRECT_MESSAGE_CLAIM },
      { session },
    );
  return ids.length;
}

/** One attempt of the sweep, inside its transaction: how many messages it removed in all. */
export async function sweptIn(
  db: Db,
  session: ClientSession,
  cutoffsByEndpoint: ReadonlyMap<string, Date>,
  limit: number,
): Promise<number> {
  let removed = 0;
  for (const [endpoint, cutoff] of cutoffsByEndpoint)
    removed += await sweptEndpointIn(db, session, endpoint, cutoff, limit);
  return removed;
}
