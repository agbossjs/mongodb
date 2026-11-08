import type { ExecutionLease } from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import type { Document, Filter } from "mongodb";
import { z } from "zod";
import { treeIdOf } from "./keys.js";
import { literal, type StoreNow } from "./store-time.js";

/**
 * The documents of `agboss_execution_leases`: one per tree, its latest lease — holder, token, the
 * expiry on the store's time (agbossjs/agboss#533), and its flags: `released`, `yielded` (#516),
 * `superseded` (closed by an outbound call's check, #508), `finished` (#520, never taken again).
 *
 * The fencing token is `token` (agbossjs/agboss#847, G7). A document written by 0.1.0 names it
 * `leaseEpoch`: every match reads either (`heldBy`, `STORED_TOKEN`), every parse answers `token`,
 * and a write of the document stores `token` and drops `leaseEpoch` — never both, so a tree's next
 * take is its last token + 1 whichever name it was written under.
 */
export interface LeaseDocument {
  _id: string;
  tenantId: string;
  rootExecutionId: string;
  holderInstanceId: string;
  token: number;
  /** The token of a document written by 0.1.0 (agbossjs/agboss#847): read, never written. */
  leaseEpoch?: number;
  expiresAt: Date;
  released: boolean;
  yielded: boolean;
  superseded: boolean;
  finished: boolean;
  /** The holder an `acquire` took the lease over from (#501), `null` when none. */
  previousHolder?: string | null;
  previousToken?: number | null;
  /** The store's time of the last fence check that locked this document. */
  checkedAt?: Date;
  /** The store's time of the last `yield` (what it answers the time left by). */
  yieldedAt?: Date;
}

/** The token as stored: `token`, else a 0.1.0 document's `leaseEpoch` (an aggregation expression). */
export const STORED_TOKEN = { $ifNull: ["$token", "$leaseEpoch"] };

/** The stage that ends every pipeline writing a lease: a 0.1.0 document's names dropped. */
export const DROP_OLD_NAMES = { $unset: ["leaseEpoch", "previousEpoch"] };

/** The token fields a lease document may carry (`token`, or a 0.1.0 `leaseEpoch`). */
export const TokenFields = z
  .object({ token: z.number().int().optional(), leaseEpoch: z.number().int().optional() })
  .refine((stored) => stored.token !== undefined || stored.leaseEpoch !== undefined, {
    message: "a lease document has a token (or a 0.1.0 leaseEpoch)",
  });

/**
 * The token of a parsed lease document: `token`, else its 0.1.0 `leaseEpoch` (`TokenFields`
 * refuses a document with neither; NaN would equal no token: every check of it refused).
 */
export const tokenOf = (stored: {
  token?: number | undefined;
  leaseEpoch?: number | undefined;
}): number => stored.token ?? stored.leaseEpoch ?? Number.NaN;

export const StoredLease = z.intersection(
  TokenFields,
  z.object({
    holderInstanceId: z.string(),
    expiresAt: z.date(),
    released: z.boolean(),
    previousHolder: z.string().nullable().optional(),
    previousToken: z.number().int().nullable().optional(),
  }),
);

/** What a `yield` reads back: the expiry and the store's time of the yield. */
export const Yielded = z.object({ expiresAt: z.date(), yieldedAt: z.date() });

/** Whether the stored lease is live at `now` (#534: `expiresAt > now`, for its holder too). */
export const liveAt = (now: StoreNow): Filter<LeaseDocument> => ({
  $expr: { $gt: ["$expiresAt", now] },
});

/** The caller's own lease: its key, holder and token (a 0.1.0 document's `leaseEpoch`). */
export const heldBy = (lease: ExecutionLease): Filter<LeaseDocument> => ({
  _id: treeIdOf(lease.tenantId, lease.rootExecutionId),
  holderInstanceId: lease.holderInstanceId,
  $or: [{ token: lease.token }, { token: { $exists: false }, leaseEpoch: lease.token }],
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
 * No lease stored yet: the upsert's insert makes the first, at token 1. A tree that has a document
 * (any lease document has a token, or a 0.1.0 `leaseEpoch`) makes it a duplicate `_id` instead.
 */
export const unleased = (id: string): Filter<LeaseDocument> => ({
  _id: id,
  token: { $exists: false },
  leaseEpoch: { $exists: false },
});

/** Whether the replaced lease ended without a release (expired, or closed by a check): a takeover. */
const WAS_TAKEN_OVER = {
  $and: [
    { $ne: [{ $ifNull: ["$token", "$leaseEpoch", null] }, null] },
    { $or: [{ $eq: ["$released", false] }, { $eq: ["$superseded", true] }] },
  ],
};

/** The update of a take: the next token for `holder`, live for `duration` from `now`. */
export function takePipeline(
  tenantId: string,
  rootExecutionId: string,
  holder: string,
  duration: Milliseconds,
  now: StoreNow,
): Document[] {
  return [
    {
      $set: {
        previousHolder: { $cond: [WAS_TAKEN_OVER, "$holderInstanceId", null] },
        previousToken: { $cond: [WAS_TAKEN_OVER, STORED_TOKEN, null] },
        tenantId: literal(tenantId),
        rootExecutionId: literal(rootExecutionId),
        holderInstanceId: literal(holder),
        token: { $add: [{ $ifNull: ["$token", "$leaseEpoch", 0] }, 1] },
        expiresAt: { $add: [now, duration] },
        released: false,
        yielded: false,
        superseded: false,
        finished: false,
      },
    },
    DROP_OLD_NAMES,
  ];
}

/** The lease `acquire` or `reclaim` answers, from the document as written. */
export function leaseOf(
  found: unknown,
  duration: Milliseconds,
  key: { readonly tenantId: string; readonly rootExecutionId: string },
): ExecutionLease {
  const stored = StoredLease.parse(found);
  const taken: ExecutionLease = {
    tenantId: key.tenantId,
    rootExecutionId: key.rootExecutionId,
    holderInstanceId: stored.holderInstanceId,
    token: tokenOf(stored),
    expiresAt: stored.expiresAt,
    // expiresAt = now + duration in the one command, both on the store's time: exactly that left
    remaining: duration,
  };
  return stored.previousHolder === null ||
    stored.previousHolder === undefined ||
    stored.previousToken === null ||
    stored.previousToken === undefined
    ? taken
    : {
        ...taken,
        takenOverFrom: {
          holderInstanceId: stored.previousHolder,
          token: stored.previousToken,
        },
      };
}
