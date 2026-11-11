import { DIRECT_MESSAGE_CLAIM, type A2ADirectMessageRecord } from "@agboss/core/a2a";
import type { ClientSession, Db } from "mongodb";
import { directMessageOf } from "./a2a-direct-message-documents.js";
import { claimsOf, directMessagesOf } from "./a2a-direct-message-save.js";

/**
 * `deleteByCreatedAtBefore` of `MongoA2ADirectMessageRepository` (agbossjs/agboss#860), inside one
 * transaction, bounded by `limit`: the oldest `limit` messages accepted before `cutoff` (each read
 * through zod first: a corrupt one fails the sweep, never vanishes unread) with their ids' claims,
 * then at most `limit` direct claims (`taskId` `""`) saved before `cutoff` whose message is gone —
 * a failed attempt's. A claim whose document a save inserts meanwhile conflicts with this removal
 * (the save writes its claim: `a2a-direct-message-save.ts`); a task's claim is never touched.
 */

/** The direct claims saved before `cutoff` with no message of theirs: at most `limit`, oldest first. */
async function orphanClaimsIn(
  db: Db,
  session: ClientSession,
  cutoff: Date,
  limit: number,
): Promise<string[]> {
  const old = await claimsOf(db)
    .find(
      { taskId: DIRECT_MESSAGE_CLAIM, savedAt: { $lt: cutoff } },
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

/** One attempt of the sweep, inside its transaction: the messages it removed. */
export async function sweptIn(
  db: Db,
  session: ClientSession,
  cutoff: Date,
  limit: number,
): Promise<readonly A2ADirectMessageRecord[]> {
  const due = await directMessagesOf(db)
    .find({ createdAt: { $lt: cutoff } }, { session, sort: { createdAt: 1, _id: 1 }, limit })
    .toArray();
  const gone = due.map(directMessageOf);
  const ids = due.map((message) => message._id);
  if (ids.length > 0) {
    await directMessagesOf(db).deleteMany({ _id: { $in: ids } }, { session });
    await claimsOf(db).deleteMany({ _id: { $in: ids }, taskId: DIRECT_MESSAGE_CLAIM }, { session });
  }
  const orphans = await orphanClaimsIn(db, session, cutoff, limit);
  if (orphans.length > 0)
    await claimsOf(db).deleteMany(
      { _id: { $in: orphans }, taskId: DIRECT_MESSAGE_CLAIM },
      { session },
    );
  return gone;
}
