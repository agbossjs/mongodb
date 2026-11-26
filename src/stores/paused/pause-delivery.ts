import { randomBytes } from "node:crypto";
import type {
  PauseMailbox,
  PauseNoticeClaim,
  PauseNoticeCounts,
  SetAsideMailbox,
} from "@agboss/core/stores";
import type { Db, Document, Filter } from "mongodb";
import { z } from "zod";
import { mailboxIdOf, mailboxOf, mailboxesOf, type MailboxDocument } from "./pause-mailboxes.js";

/**
 * The delivery of the notices (#938, #910 I9–I11): a claim holds one mailbox, so a stuck head
 * never holds another; each step is one conditional single-document command on the mailbox.
 */

/** A mailbox with a notice no receiver acknowledged. */
const UNDELIVERED: Document = { $expr: { $lt: ["$delivered", { $size: "$notices" }] } };

/** A mailbox nobody holds at `at`: no claim, or one that is over. */
const unclaimedAt = (at: Date): Filter<MailboxDocument> => ({
  $or: [{ claimedUntil: null }, { claimedUntil: { $lte: at } }],
});

/** What a mailbox that does not read is set aside with (agbossjs/agboss#1307, review #1419 L8: the core's SQLite store says the same). */
export const UNREADABLE_MAILBOX = "unreadable mailbox";

/**
 * Claims up to `limit` due mailboxes of `recipients`, oldest due first, each under a token of its
 * own. A mailbox that does not read is set aside (dead, `UNREADABLE_MAILBOX`) and the claim goes on:
 * one damaged document never fails the claim of the others, nor makes the same one be claimed
 * again and again.
 */
export async function claimDue(
  db: Db,
  at: Date,
  limit: number,
  claimFor: number,
  recipients: readonly string[],
): Promise<PauseNoticeClaim[]> {
  const until = new Date(at.getTime() + claimFor);
  const claims: PauseNoticeClaim[] = [];
  while (claims.length < limit) {
    const token = randomBytes(16).toString("hex");
    const claimed = await mailboxesOf(db).findOneAndUpdate(
      {
        recipient: { $in: [...recipients] },
        isDead: false,
        nextAttemptAt: { $lte: at },
        ...UNDELIVERED,
        ...unclaimedAt(at),
      },
      { $set: { claimToken: token, claimedUntil: until } },
      { sort: { nextAttemptAt: 1 } },
    );
    if (claimed === null) return claims;
    const mailbox = readable(claimed);
    if (mailbox === undefined) await setAsideUnreadable(db, claimed._id, token);
    else claims.push({ mailbox, token, until });
  }
  return claims;
}

/** The mailbox a document is, `undefined` when it does not read. */
function readable(found: unknown): PauseMailbox | undefined {
  try {
    return mailboxOf(found);
  } catch {
    return undefined;
  }
}

/** The unreadable mailbox, claimed under `token`, dead: never claimed again. */
async function setAsideUnreadable(db: Db, _id: string, token: string): Promise<void> {
  await mailboxesOf(db).updateOne(
    { _id, claimToken: token },
    { $set: { isDead: true, problem: UNREADABLE_MAILBOX, claimToken: null, claimedUntil: null } },
  );
}

const Claimed = z.object({ claimedUntil: z.date().nullable() });
/** A renewed claim holds: its `$max` of a held claim and the new end is never `null`. */
const Renewed = z.object({ claimedUntil: z.date() });

/**
 * Acknowledges the head — only for the claim's token and while `until > at`: the next notice is the
 * head and due at once, attempts start over; the claim stays while notices remain and is released
 * after the last (its `nextAttemptAt` and `headWrittenAt` then `null`). `headWrittenAt` is read from
 * the next notice as a Date.
 */
export async function acknowledge(
  db: Db,
  claim: PauseNoticeClaim,
  at: Date,
): Promise<PauseNoticeClaim | undefined> {
  const { tenantId, pauseId, recipient } = claim.mailbox;
  const next: Document = { $add: ["$delivered", 1] };
  const hasMore: Document = { $lt: [next, { $size: "$notices" }] };
  const nextNotice: Document = { $arrayElemAt: ["$notices", next] };
  const after = await mailboxesOf(db).findOneAndUpdate(
    {
      _id: mailboxIdOf(tenantId, pauseId, recipient),
      claimToken: claim.token,
      claimedUntil: { $gt: at },
    },
    [
      {
        $set: {
          delivered: next,
          attempts: 0,
          problem: null,
          headWrittenAt: {
            $toDate: { $getField: { field: "writtenAt", input: nextNotice } },
          },
          nextAttemptAt: { $cond: [hasMore, at, null] },
          claimToken: { $cond: [hasMore, "$claimToken", null] },
          claimedUntil: { $cond: [hasMore, "$claimedUntil", null] },
        },
      },
    ],
    { returnDocument: "after" },
  );
  if (after === null || Claimed.parse(after).claimedUntil === null) return undefined;
  return { mailbox: mailboxOf(after), token: claim.token, until: claim.until };
}

/**
 * Renews the claim while its receiver runs (#1131) — only for the claim's token and while it holds
 * (`claimedUntil > at`: a lapsed claim is never revived, another look may hold the mailbox by now):
 * held until `at + claimFor`, never earlier than it was (`$max`). `undefined` when the token was lost.
 */
export async function renew(
  db: Db,
  claim: PauseNoticeClaim,
  at: Date,
  claimFor: number,
): Promise<PauseNoticeClaim | undefined> {
  const { tenantId, pauseId, recipient } = claim.mailbox;
  const until = new Date(at.getTime() + claimFor);
  const after = await mailboxesOf(db).findOneAndUpdate(
    {
      _id: mailboxIdOf(tenantId, pauseId, recipient),
      claimToken: claim.token,
      claimedUntil: { $gt: at },
    },
    [{ $set: { claimedUntil: { $max: ["$claimedUntil", until] } } }],
    { returnDocument: "after" },
  );
  if (after === null) return undefined;
  const { claimedUntil } = Renewed.parse(after);
  return { mailbox: mailboxOf(after), token: claim.token, until: claimedUntil };
}

/** A failed attempt for the claim's token: one more, due at `nextAttemptAt`, the claim released. */
export async function retry(
  db: Db,
  claim: PauseNoticeClaim,
  nextAttemptAt: Date,
  problem: string,
): Promise<boolean> {
  const { tenantId, pauseId, recipient } = claim.mailbox;
  const held = await mailboxesOf(db).updateOne(
    { _id: mailboxIdOf(tenantId, pauseId, recipient), claimToken: claim.token },
    {
      $inc: { attempts: 1 },
      $set: { nextAttemptAt, problem, claimToken: null, claimedUntil: null },
    },
  );
  return held.matchedCount === 1;
}

/** The mailbox given up for the claim's token: dead, never claimed again. */
export async function giveUp(db: Db, claim: PauseNoticeClaim, problem: string): Promise<boolean> {
  const { tenantId, pauseId, recipient } = claim.mailbox;
  const held = await mailboxesOf(db).updateOne(
    { _id: mailboxIdOf(tenantId, pauseId, recipient), claimToken: claim.token },
    { $set: { isDead: true, problem, claimToken: null, claimedUntil: null } },
  );
  return held.matchedCount === 1;
}

const SetAside = z.object({ tenantId: z.string(), pauseId: z.string(), recipient: z.string() });

/** Sets aside, at most `limit`, the live mailboxes unclaimed at `at` whose head was written before `before`. */
export async function setAsideStale(
  db: Db,
  before: Date,
  at: Date,
  problem: string,
  limit: number,
): Promise<SetAsideMailbox[]> {
  const taken: SetAsideMailbox[] = [];
  while (taken.length < limit) {
    const one = await mailboxesOf(db).findOneAndUpdate(
      { isDead: false, headWrittenAt: { $lt: before }, ...UNDELIVERED, ...unclaimedAt(at) },
      { $set: { isDead: true, problem, claimToken: null, claimedUntil: null } },
      { sort: { headWrittenAt: 1 } },
    );
    if (one === null) return taken;
    taken.push(SetAside.parse(one));
  }
  return taken;
}

/** How many mailboxes wait for delivery (not dead, undelivered) and how many were set aside. */
export async function countMailboxes(db: Db): Promise<PauseNoticeCounts> {
  const boxes = mailboxesOf(db);
  const [live, dead] = await Promise.all([
    boxes.countDocuments({ isDead: false, ...UNDELIVERED }),
    boxes.countDocuments({ isDead: true }),
  ]);
  return { live, dead };
}
