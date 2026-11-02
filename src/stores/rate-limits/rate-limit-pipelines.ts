import type { Document } from "mongodb";
import { literal } from "../store-time.js";

/**
 * The update pipelines of `MongoRateLimitRepository` (agbossjs/agboss#483): each one command on
 * one key's document, so it is atomic without a transaction. Every time is the framework `Clock`'s,
 * as a literal — never the server's.
 */

/** One slot of a key: its id, its holder, its end. */
export interface SlotEntry {
  slotId: string;
  holderInstanceId: string;
  expiresAt: Date;
}

/** One count of a window: its moment and its amount. */
export interface BucketEntry {
  at: Date;
  amount: number;
}

/**
 * Sweeps the key's expired slots, then adds `slot` only while fewer than `maxSlots` are valid
 * (`expiresAt > now`): of two instances, never more than `maxSlots` together.
 */
export function takeSlotPipeline(slot: SlotEntry, maxSlots: number, now: Date): Document[] {
  return [
    {
      $set: {
        slots: {
          $filter: {
            input: { $ifNull: ["$slots", []] },
            as: "slot",
            cond: { $gt: ["$$slot.expiresAt", now] },
          },
        },
      },
    },
    {
      $set: {
        slots: {
          $cond: [
            { $lt: [{ $size: "$slots" }, maxSlots] },
            {
              $concatArrays: [
                "$slots",
                [
                  {
                    slotId: literal(slot.slotId),
                    holderInstanceId: literal(slot.holderInstanceId),
                    expiresAt: slot.expiresAt,
                  },
                ],
              ],
            },
            "$slots",
          ],
        },
      },
    },
  ];
}

/**
 * Forgets the window's buckets at or before `since`, sums the rest with `amount`, and keeps
 * `amount` in a bucket of `now` only when `limit` allows it (or there is none); `lastTotal` and
 * `lastAccepted` are what this command decided.
 */
export function addToWindowPipeline(
  amount: number,
  since: Date,
  now: Date,
  limit: number | undefined,
): Document[] {
  return [
    {
      $set: {
        buckets: {
          $filter: {
            input: { $ifNull: ["$buckets", []] },
            as: "bucket",
            cond: { $gt: ["$$bucket.at", since] },
          },
        },
      },
    },
    { $set: { lastTotal: { $add: [{ $sum: "$buckets.amount" }, amount] } } },
    { $set: { lastAccepted: limit === undefined ? true : { $lte: ["$lastTotal", limit] } } },
    {
      $set: {
        buckets: {
          $cond: [
            { $and: ["$lastAccepted", amount !== 0] },
            { $concatArrays: ["$buckets", [{ at: now, amount }]] },
            "$buckets",
          ],
        },
      },
    },
  ];
}
