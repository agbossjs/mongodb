import {
  A2ATaskState,
  InvalidA2APageTokenError,
  isTerminalA2ATaskState,
  PauseKind,
  type A2AMessageKey,
  type A2AMessageRecord,
  type A2ATaskKey,
  type A2ATaskRecord,
  type A2ATaskStatus,
} from "@agboss/core";
import { z } from "zod";
import { idOf } from "../keys.js";

/**
 * The documents of `MongoA2ATaskRepository` (agbossjs/agboss#824): a task and an accepted message,
 * each `_id` its key's texts; the status and a reply as JSON text (any key, a NUL character
 * included, comes back as written), read through zod; and the page token of `list`.
 */

export interface A2ATaskDocument {
  _id: string;
  tenantId: string;
  taskId: string;
  /** `""` for none, which no owner's id is (agbossjs/agboss#589). */
  ownerId: string;
  contextId: string;
  skill: string;
  state: A2ATaskState;
  status: string;
  version: number;
  acceptedAt: Date;
  statusAt: Date;
  callerPeer?: string;
  /** agbossjs/agboss#810: a trusted task's first message's `bodyHash`; absent on one saved before. */
  meshBodyHash?: string;
}

export interface A2AMessageDocument {
  _id: string;
  tenantId: string;
  ownerId: string;
  messageId: string;
  requestHash: string;
  taskId: string;
  savedAt: Date;
  /** JSON text once it has one (absent before): a reply of JSON `null` is `"null"`. */
  reply?: string;
}

export const TERMINAL_STATES: readonly A2ATaskState[] =
  Object.values(A2ATaskState).filter(isTerminalA2ATaskState);

export const ownerColumnOf = (ownerId: string | undefined): string => ownerId ?? "";
const ownerOf = (column: string): string | undefined => (column === "" ? undefined : column);

export const taskIdOf = (key: A2ATaskKey): string => idOf(key.tenantId, key.taskId);
export const messageIdOf = (key: A2AMessageKey): string =>
  idOf(key.tenantId, ownerColumnOf(key.ownerId), key.messageId);

/**
 * A status as written: a corrupt one is refused, never read as a task's state; a key this store does
 * not know is kept as it was written (agbossjs/agboss#960, `a2aTaskContract`'s rule for every store)
 * — a status the core grew is never read back without it (#810: a mesh refusal's facts and a
 * completion's spend were dropped so).
 */
const Status = z.looseObject({
  state: z.enum(A2ATaskState),
  message: z.string().optional(),
  pendingPauses: z.array(
    z.object({ pauseId: z.string().optional(), kind: z.enum(PauseKind), ask: z.unknown() }),
  ),
  finish: z.string().optional(),
  output: z.unknown().optional(),
  errorCode: z.string().optional(),
  // agbossjs/agboss#810: a mesh limit's facts (REJECTED), the execution's spend (COMPLETED)
  errorDetails: z.unknown().optional(),
  spentUsd: z.number().nonnegative().optional(),
  cancelRequestedAt: z.iso.datetime().optional(),
});

const StoredTask = z.object({
  tenantId: z.string(),
  taskId: z.string(),
  ownerId: z.string(),
  contextId: z.string(),
  skill: z.string(),
  state: z.enum(A2ATaskState),
  status: z.string(),
  version: z.number().int().positive(),
  acceptedAt: z.date(),
  statusAt: z.date(),
  callerPeer: z.string().optional(),
  meshBodyHash: z.string().optional(),
});

const StoredMessage = z.object({
  tenantId: z.string(),
  ownerId: z.string(),
  messageId: z.string(),
  requestHash: z.string(),
  taskId: z.string(),
  savedAt: z.date(),
  reply: z.string().optional(),
});

export const taskDocumentOf = (task: A2ATaskRecord): A2ATaskDocument => ({
  _id: taskIdOf(task),
  tenantId: task.tenantId,
  taskId: task.taskId,
  ownerId: ownerColumnOf(task.ownerId),
  contextId: task.contextId,
  skill: task.skill,
  state: task.status.state,
  status: JSON.stringify(task.status),
  version: task.version,
  acceptedAt: task.acceptedAt,
  statusAt: task.statusAt,
  ...(task.callerPeer === undefined ? {} : { callerPeer: task.callerPeer }),
  ...(task.meshBodyHash === undefined ? {} : { meshBodyHash: task.meshBodyHash }),
});

export const messageDocumentOf = (message: A2AMessageRecord): A2AMessageDocument => ({
  _id: messageIdOf(message),
  tenantId: message.tenantId,
  ownerId: ownerColumnOf(message.ownerId),
  messageId: message.messageId,
  requestHash: message.requestHash,
  taskId: message.taskId,
  savedAt: message.savedAt,
  ...(message.reply === undefined ? {} : { reply: replyTextOf(message.reply) }),
});

/** A reply as kept: `JSON.stringify(undefined)` is no text, so nothing is JSON `null`. */
export const replyTextOf = (reply: unknown): string =>
  reply === undefined ? "null" : JSON.stringify(reply);

export function taskOf(document: unknown): A2ATaskRecord {
  const stored = StoredTask.parse(document);
  const status: A2ATaskStatus = Status.parse(JSON.parse(stored.status));
  if (status.state !== stored.state)
    throw new Error(`agboss_a2a_tasks ${stored.taskId}: its state and its status disagree`);
  return {
    tenantId: stored.tenantId,
    taskId: stored.taskId,
    ownerId: ownerOf(stored.ownerId),
    contextId: stored.contextId,
    skill: stored.skill,
    status,
    version: stored.version,
    acceptedAt: stored.acceptedAt,
    statusAt: stored.statusAt,
    ...(stored.callerPeer === undefined ? {} : { callerPeer: stored.callerPeer }),
    ...(stored.meshBodyHash === undefined ? {} : { meshBodyHash: stored.meshBodyHash }),
  };
}

export function messageOf(document: unknown): A2AMessageRecord {
  const stored = StoredMessage.parse(document);
  return {
    tenantId: stored.tenantId,
    ownerId: ownerOf(stored.ownerId),
    messageId: stored.messageId,
    requestHash: stored.requestHash,
    taskId: stored.taskId,
    savedAt: stored.savedAt,
    ...(stored.reply === undefined ? {} : { reply: JSON.parse(stored.reply) as unknown }),
  };
}

/** The greatest time a `Date` holds, in ms either side of 1970. */
const MAX_TIME = 8.64e15;

/** A token's content: the status time (one a date holds) and the id of the last task given. */
const PositionToken = z.tuple([z.int().min(-MAX_TIME).max(MAX_TIME), z.string()]);

/** The opaque token of the page after `task`. */
export const pageTokenOf = (task: Pick<A2ATaskRecord, "statusAt" | "taskId">): string =>
  Buffer.from(JSON.stringify([task.statusAt.getTime(), task.taskId])).toString("base64url");

function jsonOf(token: string): unknown {
  try {
    return JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Where the page of `token` starts; `InvalidA2APageTokenError` for a token no list gave. */
export function pagePositionOf(token: string): {
  readonly statusAt: Date;
  readonly taskId: string;
} {
  const parsed = PositionToken.safeParse(jsonOf(token));
  if (!parsed.success) throw new InvalidA2APageTokenError();
  const [statusAt, taskId] = parsed.data;
  return { statusAt: new Date(statusAt), taskId };
}
