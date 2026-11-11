import {
  A2ADirectMessageState,
  type A2ADirectMessageKey,
  type A2ADirectMessageRecord,
  type A2ADirectMessageReply,
} from "@agboss/core/a2a";
import { z } from "zod";
import { messageIdOf, ownerColumnOf } from "../a2a-tasks/a2a-task-documents.js";

/**
 * The document of `MongoA2ADirectMessageRepository` (agbossjs/agboss#860): one per accepted direct
 * message, `_id` its key's texts — the `_id` of its claim among the A2A task store's messages too
 * (`messageIdOf`). The reply as JSON text (a NUL character included comes back as written), read
 * through zod: a corrupt document, or one whose state and reply disagree, is refused.
 */

export interface A2ADirectMessageDocument {
  _id: string;
  tenantId: string;
  /** `""` for none, which no owner's id is (agbossjs/agboss#589). */
  ownerId: string;
  messageId: string;
  requestHash: string;
  skill: string;
  contextId: string;
  state: A2ADirectMessageState;
  attemptId: string;
  startedAt: Date;
  expiresAt: Date;
  callsModel: boolean;
  createdAt: Date;
  callerPeer?: string;
  meshBodyHash?: string;
  /** JSON text (`Completed`), absent before. */
  reply?: string;
  completedAt?: Date;
}

export const directIdOf = (key: A2ADirectMessageKey): string => messageIdOf(key);

/** A reply as kept: strict — a field this store does not know is refused, never dropped. */
const Reply = z.strictObject({
  finish: z.string(),
  output: z.unknown(),
  spentUsd: z.number().nonnegative(),
});

const Stored = z.object({
  tenantId: z.string(),
  ownerId: z.string(),
  messageId: z.string(),
  requestHash: z.string(),
  skill: z.string(),
  contextId: z.string(),
  state: z.enum(A2ADirectMessageState),
  attemptId: z.string(),
  startedAt: z.date(),
  expiresAt: z.date(),
  callsModel: z.boolean(),
  createdAt: z.date(),
  callerPeer: z.string().optional(),
  meshBodyHash: z.string().optional(),
  reply: z.string().optional(),
  completedAt: z.date().optional(),
});

/** The reply's JSON text as written. */
export const replyTextOf = (reply: A2ADirectMessageReply): string => JSON.stringify(reply);

export const directDocumentOf = (message: A2ADirectMessageRecord): A2ADirectMessageDocument => ({
  _id: directIdOf(message),
  tenantId: message.tenantId,
  ownerId: ownerColumnOf(message.ownerId),
  messageId: message.messageId,
  requestHash: message.requestHash,
  skill: message.skill,
  contextId: message.contextId,
  state: message.state,
  attemptId: message.attemptId,
  startedAt: message.startedAt,
  expiresAt: message.expiresAt,
  callsModel: message.callsModel,
  createdAt: message.createdAt,
  ...(message.callerPeer === undefined ? {} : { callerPeer: message.callerPeer }),
  ...(message.meshBodyHash === undefined ? {} : { meshBodyHash: message.meshBodyHash }),
  ...(message.reply === undefined ? {} : { reply: replyTextOf(message.reply) }),
  ...(message.completedAt === undefined ? {} : { completedAt: message.completedAt }),
});

/** The reply of a stored document: both it and its time while `Completed`, neither before. */
function replyOf(
  stored: z.infer<typeof Stored>,
): Pick<A2ADirectMessageRecord, "reply" | "completedAt"> {
  const completed = stored.state === A2ADirectMessageState.Completed;
  const hasReply = stored.reply !== undefined && stored.completedAt !== undefined;
  const hasNone = stored.reply === undefined && stored.completedAt === undefined;
  if (completed ? !hasReply : !hasNone)
    throw new Error(
      `agboss_a2a_direct_messages ${JSON.stringify(stored.messageId)}: its state and its reply disagree`,
    );
  if (stored.reply === undefined || stored.completedAt === undefined) return {};
  return { reply: Reply.parse(JSON.parse(stored.reply)), completedAt: stored.completedAt };
}

/** A document read back, parsed: a corrupt one is refused, never read as a message. */
export function directMessageOf(document: unknown): A2ADirectMessageRecord {
  const stored = Stored.parse(document);
  return {
    tenantId: stored.tenantId,
    ownerId: stored.ownerId === "" ? undefined : stored.ownerId,
    messageId: stored.messageId,
    requestHash: stored.requestHash,
    skill: stored.skill,
    contextId: stored.contextId,
    state: stored.state,
    attemptId: stored.attemptId,
    startedAt: stored.startedAt,
    expiresAt: stored.expiresAt,
    callsModel: stored.callsModel,
    createdAt: stored.createdAt,
    ...(stored.callerPeer === undefined ? {} : { callerPeer: stored.callerPeer }),
    ...(stored.meshBodyHash === undefined ? {} : { meshBodyHash: stored.meshBodyHash }),
    ...replyOf(stored),
  };
}
