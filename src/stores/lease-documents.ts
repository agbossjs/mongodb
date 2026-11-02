import type { ExecutionLease } from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import type { Document, Filter } from "mongodb";
import { z } from "zod";
import { treeIdOf } from "./keys.js";
import { literal, type StoreNow } from "./store-time.js";

/**
 * The documents of `agboss_execution_leases`: one per tree, its latest lease — holder, epoch, the
 * expiry on the store's time (agbossjs/agboss#533), and its flags: `released`, `yielded` (#516),
 * `superseded` (closed by an outbound call's check, #508), `finished` (#520, never taken again).
 */
export interface LeaseDocument {
  _id: string;
  tenantId: string;
  rootExecutionId: string;
  holderInstanceId: string;
  leaseEpoch: number;
  expiresAt: Date;
  released: boolean;
  yielded: boolean;
  superseded: boolean;
  finished: boolean;
  /** The holder an `acquire` took the lease over from (#501), `null` when none. */
  previousHolder?: string | null;
  previousEpoch?: number | null;
  /** The store's time of the last fence check that locked this document. */
  checkedAt?: Date;
}

export const StoredLease = z.object({
  holderInstanceId: z.string(),
  leaseEpoch: z.number().int(),
  expiresAt: z.date(),
  released: z.boolean(),
  previousHolder: z.string().nullable().optional(),
  previousEpoch: z.number().int().nullable().optional(),
});

/** Whether the stored lease is live at `now` (#534: `expiresAt > now`, for its holder too). */
export const liveAt = (now: StoreNow): Filter<LeaseDocument> => ({
  $expr: { $gt: ["$expiresAt", now] },
});

/** The caller's own lease: its key, holder and epoch. */
export const heldBy = (lease: ExecutionLease): Filter<LeaseDocument> => ({
  _id: treeIdOf(lease.tenantId, lease.rootExecutionId),
  holderInstanceId: lease.holderInstanceId,
  leaseEpoch: lease.leaseEpoch,
});

/** The caller's own lease, not released and still live at `now`: what renew, yield, reclaim match. */
export const liveHeldBy = (lease: ExecutionLease, now: StoreNow): Filter<LeaseDocument> => ({
  ...heldBy(lease),
  released: false,
  ...liveAt(now),
});

/** A stored lease `acquire` may take over: not finished, and released or expired at `now`. */
export const takeable = (id: string, now: StoreNow): Filter<LeaseDocument> => ({
  _id: id,
  finished: false,
  $or: [{ released: true }, { $expr: { $lte: ["$expiresAt", now] } }],
});

/**
 * No lease stored yet: the upsert's insert makes the first, at epoch 1. A tree that has a document
 * (any lease document has an epoch) makes it a duplicate `_id` instead.
 */
export const unleased = (id: string): Filter<LeaseDocument> => ({
  _id: id,
  leaseEpoch: { $exists: false },
});

/** Whether the replaced lease ended without a release (expired, or closed by a check): a takeover. */
const WAS_TAKEN_OVER = {
  $and: [
    { $ne: [{ $type: "$leaseEpoch" }, "missing"] },
    { $or: [{ $eq: ["$released", false] }, { $eq: ["$superseded", true] }] },
  ],
};

/** The update of a take: the next epoch for `holder`, live for `lease` from `now`. */
export function takePipeline(
  tenantId: string,
  rootExecutionId: string,
  holder: string,
  lease: Milliseconds,
  now: StoreNow,
): Document[] {
  return [
    {
      $set: {
        previousHolder: { $cond: [WAS_TAKEN_OVER, "$holderInstanceId", null] },
        previousEpoch: { $cond: [WAS_TAKEN_OVER, "$leaseEpoch", null] },
        tenantId: literal(tenantId),
        rootExecutionId: literal(rootExecutionId),
        holderInstanceId: literal(holder),
        leaseEpoch: { $add: [{ $ifNull: ["$leaseEpoch", 0] }, 1] },
        expiresAt: { $add: [now, lease] },
        released: false,
        yielded: false,
        superseded: false,
        finished: false,
      },
    },
  ];
}

/** The lease `acquire` or `reclaim` answers, from the document as written. */
export function leaseOf(
  found: unknown,
  lease: Milliseconds,
  key: { readonly tenantId: string; readonly rootExecutionId: string },
): ExecutionLease {
  const stored = StoredLease.parse(found);
  const taken: ExecutionLease = {
    tenantId: key.tenantId,
    rootExecutionId: key.rootExecutionId,
    holderInstanceId: stored.holderInstanceId,
    leaseEpoch: stored.leaseEpoch,
    expiresAt: stored.expiresAt,
    // expiresAt = now + lease in the one command, both on the store's time: exactly `lease` left
    remaining: lease,
  };
  return stored.previousHolder === null ||
    stored.previousHolder === undefined ||
    stored.previousEpoch === null ||
    stored.previousEpoch === undefined
    ? taken
    : {
        ...taken,
        takenOverFrom: {
          holderInstanceId: stored.previousHolder,
          leaseEpoch: stored.previousEpoch,
        },
      };
}
