import {
  A2ADirectMessageSaveStatus,
  A2ADirectMessageState,
  DIRECT_MESSAGE_CLAIM,
  directMessageClaimOf,
  type A2ADirectMessageRecord,
  type A2ADirectMessageSave,
  type A2AMessageRecord,
  type NewA2ADirectMessage,
} from "@agboss/core/stores";
import type { ClientSession, Collection, Db } from "mongodb";
import { Collections } from "../../connection/collections.js";
import {
  messageDocumentOf,
  messageOf,
  type A2AMessageDocument,
} from "../a2a-tasks/a2a-task-documents.js";
import {
  directDocumentOf,
  directIdOf,
  directMessageOf,
  type A2ADirectMessageDocument,
} from "./a2a-direct-message-documents.js";

/**
 * `saveIfAbsent` of `MongoA2ADirectMessageRepository` (agbossjs/agboss#860), inside one
 * transaction: the message's own document, then its id's claim among the A2A task store's messages
 * (`agboss_a2a_messages`, the same `_id`) — kept: its row; a task's claim, or a direct claim of
 * another hash: taken; else the claim is written (inserted, or a claim of ours, left by a failed
 * attempt, deleted and inserted again with its first acceptance's time) and the document inserted.
 *
 * The claim is always **written**, never only read: a read in a transaction does not lock, so the
 * sweep's removal of a claim whose document it saw gone, and this save's insert of the document,
 * would otherwise both commit (write skew) and leave a message whose id no claim holds. Written,
 * the two conflict on the claim (`WriteConflict`: the driver runs the later one again, which reads
 * the other's outcome) — as a task's transaction inserting the same claim conflicts with this one.
 */

export const claimsOf = (db: Db): Collection<A2AMessageDocument> =>
  db.collection<A2AMessageDocument>(Collections.A2AMessages);
export const directMessagesOf = (db: Db): Collection<A2ADirectMessageDocument> =>
  db.collection<A2ADirectMessageDocument>(Collections.A2ADirectMessages);

/** A message as `saveIfAbsent` keeps it: `InFlight`, its first attempt. */
const savedOf = (message: NewA2ADirectMessage): A2ADirectMessageRecord => ({
  tenantId: message.tenantId,
  ownerId: message.ownerId,
  messageId: message.messageId,
  requestHash: message.requestHash,
  skill: message.skill,
  contextId: message.contextId,
  state: A2ADirectMessageState.InFlight,
  attemptId: message.attemptId,
  startedAt: message.startedAt,
  expiresAt: message.expiresAt,
  callsModel: message.callsModel,
  createdAt: message.createdAt,
  ...(message.callerPeer === undefined ? {} : { callerPeer: message.callerPeer }),
  ...(message.meshBodyHash === undefined ? {} : { meshBodyHash: message.meshBodyHash }),
});

/**
 * The claim the message's id is to be written with: its own (first accepted then, or the claim of
 * ours a failed attempt left — its first acceptance's time kept, as every store keeps it), or
 * `undefined` when the id is another message's.
 */
async function claimFor(
  db: Db,
  session: ClientSession,
  message: NewA2ADirectMessage,
): Promise<A2AMessageRecord | undefined> {
  const found = await claimsOf(db).findOne({ _id: directIdOf(message) }, { session });
  const claim = directMessageClaimOf(message);
  if (found === null) return claim;
  const kept = messageOf(found);
  const isOurs = kept.taskId === DIRECT_MESSAGE_CLAIM && kept.requestHash === message.requestHash;
  return isOurs ? { ...claim, savedAt: kept.savedAt } : undefined;
}

/** One attempt of `saveIfAbsent`, inside its transaction. */
export async function directSavedIn(
  db: Db,
  session: ClientSession,
  message: NewA2ADirectMessage,
): Promise<A2ADirectMessageSave> {
  const _id = directIdOf(message);
  const kept = await directMessagesOf(db).findOne({ _id }, { session });
  if (kept !== null)
    return { status: A2ADirectMessageSaveStatus.Kept, message: directMessageOf(kept) };
  const claim = await claimFor(db, session, message);
  if (claim === undefined) return { status: A2ADirectMessageSaveStatus.Taken };
  // ours or none: written either way (see above)
  await claimsOf(db).deleteOne({ _id, taskId: DIRECT_MESSAGE_CLAIM }, { session });
  await claimsOf(db).insertOne(messageDocumentOf(claim), { session });
  const saved = savedOf(message);
  await directMessagesOf(db).insertOne(directDocumentOf(saved), { session });
  return { status: A2ADirectMessageSaveStatus.Saved, message: saved };
}
