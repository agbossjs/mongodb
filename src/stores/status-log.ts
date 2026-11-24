import {
  StatusTrigger,
  ThreadStatus,
  type NewStatusTransition,
  type ThreadStatusTransition,
} from "@agboss/core";
import type { StatusContext } from "@agboss/core/stores";
import type { ClientSession, Db } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";
import { idOf } from "./keys.js";

/**
 * The status history of a thread (agbossjs/agboss#1341d) on MongoDB: one document of
 * `agboss_thread_status_transitions` per change of the thread's status, written in the very
 * transaction of the change — a lease's mark or a record's status write — so a crash between the
 * change and its document is impossible by construction. The rules that say which write is a change
 * (`transitionOf`, `recordTransitionOf`) are the core's, restated here from its public enums.
 *
 * The thread's writers are ordered by the document's `_id` (`tenantId`, `threadId`, `seq`): two
 * transactions that read the same last `seq` both insert the next one, and the second is a write
 * conflict — a `TransientTransactionError`, so the driver runs it again on a snapshot that holds
 * the first's document.
 */

interface Thread {
  readonly tenantId: string;
  readonly threadId: string;
}

/** One stored change. */
export interface TransitionDocument {
  _id: string;
  tenantId: string;
  threadId: string;
  seq: number;
  fromStatus: ThreadStatus | null;
  toStatus: ThreadStatus;
  trigger: StatusTrigger;
  reason?: string;
  actor?: string;
  leaseToken?: number;
  at: Date;
}

const Stored = z.object({
  tenantId: z.string(),
  threadId: z.string(),
  seq: z.number().int(),
  fromStatus: z.enum(ThreadStatus).nullable(),
  toStatus: z.enum(ThreadStatus),
  trigger: z.enum(StatusTrigger),
  reason: z.string().optional(),
  actor: z.string().optional(),
  leaseToken: z.number().int().optional(),
  at: z.date(),
});

const transitionsOf = (db: Db) =>
  db.collection<TransitionDocument>(Collections.ThreadStatusTransitions);

/** A stored document → a transition. */
export function transitionOfDocument(document: unknown): ThreadStatusTransition {
  const stored = Stored.parse(document);
  return {
    tenantId: stored.tenantId,
    threadId: stored.threadId,
    seq: stored.seq,
    fromStatus: stored.fromStatus,
    toStatus: stored.toStatus,
    trigger: stored.trigger,
    ...(stored.reason === undefined ? {} : { reason: stored.reason }),
    ...(stored.actor === undefined ? {} : { actor: stored.actor }),
    ...(stored.leaseToken === undefined ? {} : { leaseToken: stored.leaseToken }),
    at: stored.at,
  };
}

/** The statuses a stop or a cancel under way keeps the thread in while its record moves through `running`. */
const ENDING: readonly (ThreadStatus | undefined)[] = [
  ThreadStatus.Stopping,
  ThreadStatus.Cancelling,
];

/** The reason, actor and lease token of a command's context, those it gave. */
const detailsOf = (context: StatusContext | undefined) => ({
  ...(context?.reason === undefined ? {} : { reason: context.reason }),
  ...(context?.actor === undefined ? {} : { actor: context.actor }),
  ...(context?.leaseToken === undefined ? {} : { leaseToken: context.leaseToken }),
});

/**
 * The row a status change writes, or `undefined` when it changes nothing: a repeated command, or a
 * write that leaves the thread's status as it was, is not a transition; a stop or cancel under way
 * moves its record through `running` while it ends, and the thread is still stopping or cancelling.
 */
export function transitionOf(
  next: NewStatusTransition,
  last: ThreadStatusTransition | undefined,
  at: Date,
): ThreadStatusTransition | undefined {
  if (last?.toStatus === next.toStatus) return undefined;
  if (next.toStatus === ThreadStatus.Running && ENDING.includes(last?.toStatus)) return undefined;
  const { reason, actor, leaseToken, ...base } = next;
  return {
    ...base,
    seq: (last?.seq ?? 0) + 1,
    fromStatus: last?.toStatus ?? null,
    ...detailsOf({ reason, actor, leaseToken }),
    at,
  };
}

/** The thread status each record status makes, and what made it when no command says so. */
const RECORD_STATUS: Readonly<
  Record<string, { readonly status: ThreadStatus; readonly trigger: StatusTrigger } | undefined>
> = {
  running: { status: ThreadStatus.Running, trigger: StatusTrigger.Start },
  paused: { status: ThreadStatus.Paused, trigger: StatusTrigger.Ask },
  answered: { status: ThreadStatus.Finished, trigger: StatusTrigger.Finish },
  guarded: { status: ThreadStatus.Finished, trigger: StatusTrigger.Finish },
  failed: { status: ThreadStatus.Failed, trigger: StatusTrigger.Fail },
  stopped: { status: ThreadStatus.Stopped, trigger: StatusTrigger.Stop },
  cancelled: { status: ThreadStatus.Cancelled, trigger: StatusTrigger.Cancel },
};

/** What made the change when no command says: a record running again after a pause is a resume. */
function triggerOf(
  made: { readonly status: ThreadStatus; readonly trigger: StatusTrigger },
  last: ThreadStatusTransition | undefined,
): StatusTrigger {
  const wasPaused =
    last?.toStatus === ThreadStatus.Paused || last?.toStatus === ThreadStatus.DualPaused;
  return made.status === ThreadStatus.Running && wasPaused ? StatusTrigger.Resume : made.trigger;
}

/**
 * The transition a record's status write makes, from the statuses alone (a command's context
 * overrides the trigger): `undefined` for a status that is no thread status (`queued`, `written`).
 */
export function recordTransitionOf(
  thread: Thread,
  recordStatus: string,
  last: ThreadStatusTransition | undefined,
  context: StatusContext | undefined,
): NewStatusTransition | undefined {
  const made = RECORD_STATUS[recordStatus];
  if (made === undefined) return undefined;
  return {
    ...thread,
    toStatus: context?.toStatus ?? made.status,
    trigger: context?.trigger ?? triggerOf(made, last),
    ...detailsOf(context),
  };
}

/** The thread's last change, read in the caller's transaction. */
async function lastOf(
  db: Db,
  session: ClientSession,
  thread: Thread,
): Promise<ThreadStatusTransition | undefined> {
  const found = await transitionsOf(db).findOne(
    { tenantId: thread.tenantId, threadId: thread.threadId },
    { session, sort: { seq: -1 } },
  );
  return found === null ? undefined : transitionOfDocument(found);
}

/**
 * Appends `next` to the thread's history in the caller's transaction, unless it changes nothing;
 * the change written, or `undefined`.
 */
export async function appendStatus(
  db: Db,
  session: ClientSession,
  next: NewStatusTransition,
  at: Date,
): Promise<ThreadStatusTransition | undefined> {
  const written = transitionOf(next, await lastOf(db, session, next), at);
  if (written === undefined) return undefined;
  await transitionsOf(db).insertOne(
    {
      _id: idOf(written.tenantId, written.threadId, written.seq),
      tenantId: written.tenantId,
      threadId: written.threadId,
      seq: written.seq,
      fromStatus: written.fromStatus,
      toStatus: written.toStatus,
      trigger: written.trigger,
      ...(written.reason === undefined ? {} : { reason: written.reason }),
      ...(written.actor === undefined ? {} : { actor: written.actor }),
      ...(written.leaseToken === undefined ? {} : { leaseToken: written.leaseToken }),
      at: written.at,
    },
    { session },
  );
  return written;
}

/**
 * The status change a write of record status `recordStatus` makes, appended in the write's own
 * transaction: a crash between the status and its document is impossible.
 */
export async function appendRecordStatus(
  db: Db,
  session: ClientSession,
  thread: Thread,
  write: {
    readonly status: string;
    readonly context: StatusContext | undefined;
    readonly at: Date;
  },
): Promise<void> {
  const next = recordTransitionOf(
    thread,
    write.status,
    await lastOf(db, session, thread),
    write.context,
  );
  if (next !== undefined) await appendStatus(db, session, next, write.at);
}

/** The thread's history, oldest first. */
export async function historyOf(
  db: Db,
  thread: Thread,
): Promise<readonly ThreadStatusTransition[]> {
  const found = await transitionsOf(db)
    .find({ tenantId: thread.tenantId, threadId: thread.threadId })
    .sort({ seq: 1 })
    .toArray();
  return found.map(transitionOfDocument);
}

/** Removes the thread's documents (its tree was forgotten, or the thread was swept). */
export async function forgottenStatus(
  db: Db,
  thread: Thread,
  session?: ClientSession,
): Promise<void> {
  await transitionsOf(db).deleteMany(
    { tenantId: thread.tenantId, threadId: thread.threadId },
    session === undefined ? {} : { session },
  );
}
