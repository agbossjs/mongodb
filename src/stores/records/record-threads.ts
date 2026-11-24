import type { NewThread } from "@agboss/core";
import type { Collection, Db } from "mongodb";
import { z } from "zod";
import { Collections } from "../../connection/collections.js";
import { DUPLICATE_KEY, hasCode, idOf } from "../keys.js";

/** Threads: their owners, their activity and the tombstone a sweep leaves (#550, #1303). */

export interface ThreadDocument {
  _id: string;
  tenantId: string;
  threadId: string;
  workflow: string;
  owner: string | null;
  createdAt: Date;
  /** What a memory's `ttl` counts from (#1303): the last write to one of the thread's records. */
  lastActiveAt: Date;
  /** A thread the memory sweep emptied (#1303c): its owner's tombstone, no other owner may take the id. */
  isSwept: boolean;
}

const Owner = z.object({ owner: z.string().nullable(), isSwept: z.boolean().optional() });

export const threadsOf = (db: Db): Collection<ThreadDocument> =>
  db.collection<ThreadDocument>(Collections.Threads);

/**
 * A new thread: `true` when this insert made it, `false` when the tenant has the id already — the
 * first insert keeps it (and its owner), its `_id` unique.
 */
export async function createThread(
  db: Db,
  thread: NewThread,
  id: string,
  now: Date,
): Promise<boolean> {
  try {
    await threadsOf(db).insertOne({
      _id: idOf(thread.tenantId, id),
      tenantId: thread.tenantId,
      threadId: id,
      workflow: thread.workflow,
      owner: thread.ownerId ?? null,
      createdAt: now,
      lastActiveAt: now,
      isSwept: false,
    });
    return true;
  } catch (error) {
    if (hasCode(error, DUPLICATE_KEY)) return false;
    throw error;
  }
}

/**
 * A caller's own id the tenant already has: kept as it is — except a swept thread (#1303c), fail
 * closed: a different caller, or one naming no owner, is refused; its owner restarts it (the one
 * place the tombstone is cleared), in one conditional update.
 */
export async function claimExisting(
  db: Db,
  claim: {
    readonly tenantId: string;
    readonly threadId: string;
    readonly ownerId?: string | undefined;
  },
  now: Date,
): Promise<void> {
  const _id = idOf(claim.tenantId, claim.threadId);
  const found = await threadsOf(db).findOne({ _id });
  if (found?.isSwept !== true) return;
  const restarted = await threadsOf(db).updateOne(
    { _id, isSwept: true, owner: claim.ownerId ?? null },
    { $set: { isSwept: false, lastActiveAt: now } },
  );
  if (restarted.matchedCount === 0 && (found.owner ?? undefined) !== claim.ownerId)
    throw new Error("the thread belongs to another owner: it is not created again");
}

/**
 * A caller's own thread id: created, or — the tenant has it already — kept as it is, except a swept
 * one (#1303c), which only its owner restarts.
 */
export async function createOwnThread(
  db: Db,
  thread: NewThread,
  id: string,
  now: Date,
): Promise<void> {
  if (await createThread(db, thread, id, now)) return;
  await claimExisting(
    db,
    { tenantId: thread.tenantId, threadId: id, ownerId: thread.ownerId },
    now,
  );
}

/** The thread's owner (`owner: undefined`: created without one); `undefined` when there is no such thread. */
export async function threadOwnerOf(
  db: Db,
  workflow: string,
  tenantId: string,
  threadId: string,
): Promise<{ readonly owner: string | undefined; readonly isSwept?: true } | undefined> {
  const found = await threadsOf(db).findOne({ _id: idOf(tenantId, threadId), workflow });
  if (found === null) return undefined;
  const { owner, isSwept } = Owner.parse(found);
  // a swept thread is the owner's emptied tombstone: only its owner may restart it
  return { owner: owner ?? undefined, ...(isSwept === true ? { isSwept: true as const } : {}) };
}
