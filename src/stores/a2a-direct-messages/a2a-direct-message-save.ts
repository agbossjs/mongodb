import {
  A2ADirectMessageSaveStatus,
  A2ADirectMessageState,
  DIRECT_MESSAGE_CLAIM,
  directMessageClaimOf,
  type A2ADirectMessageRecord,
  type A2ADirectMessageSave,
  type NewA2ADirectMessage,
} from "@agboss/core/a2a";
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
 * attempt, deleted and inserted again) and the document inserted.
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

/** Whether the claim kept under the message's id is another message's. */
async function isTakenIn(
  db: Db,
  session: ClientSession,
  message: NewA2ADirectMessage,
): Promise<boolean> {
  const found = await claimsOf(db).findOne({ _id: directIdOf(message) }, { session });
  if (found === null) return false;
  const claim = messageOf(found);
  return claim.taskId !== DIRECT_MESSAGE_CLAIM || claim.requestHash !== message.requestHash;
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
  if (await isTakenIn(db, session, message)) return { status: A2ADirectMessageSaveStatus.Taken };
  // ours or none: written either way (see above), its time this message's acceptance
  await claimsOf(db).deleteOne({ _id, taskId: DIRECT_MESSAGE_CLAIM }, { session });
  await claimsOf(db).insertOne(messageDocumentOf(directMessageClaimOf(message)), { session });
  const saved = savedOf(message);
  await directMessagesOf(db).insertOne(directDocumentOf(saved), { session });
  return { status: A2ADirectMessageSaveStatus.Saved, message: saved };
}
