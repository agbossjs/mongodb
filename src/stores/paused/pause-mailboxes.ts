import { PauseClosedReason } from "@agboss/core";
import { PauseNoticeKind, type PauseMailbox } from "@agboss/core/stores";
import type { ClientSession, Collection, Db, Document } from "mongodb";
import { z } from "zod";
import { Collections } from "../../connection/collections.js";
import { idOf } from "../keys.js";
import type { PlannedNotice } from "./pause-changes.js";

/**
 * The mailboxes of the pause notices (#938, #910 I8–I10): one document per pause and receiver,
 * `_id` their tenant, pause and recipient, holding every notice in the order written (`seq` 1, 2,
 * …) and what a delivery needs — `delivered`, `attempts`, `nextAttemptAt` (`null` once everything
 * is delivered: the claim's index never walks the finished), `headWrittenAt` (the first
 * undelivered notice's time, `null` when none), `isDead`, and the claim (`claimToken`,
 * `claimedUntil`). **`headWrittenAt` and every notice's `writtenAt` are BSON Dates**, never ISO
 * strings: the stale look compares them with a Date, and a string never sorts below one. The
 * store converts to ISO text only when it returns a `PauseNotice`.
 */
export interface MailboxDocument {
  _id: string;
  tenantId: string;
  pauseId: string;
  recipient: string;
  notices: Document[];
  delivered: number;
  attempts: number;
  nextAttemptAt: Date | null;
  headWrittenAt: Date | null;
  isDead: boolean;
  problem?: string | null;
  claimToken: string | null;
  claimedUntil: Date | null;
}

export const mailboxIdOf = (tenantId: string, pauseId: string, recipient: string): string =>
  idOf(tenantId, pauseId, recipient);

export const mailboxesOf = (db: Db): Collection<MailboxDocument> =>
  db.collection<MailboxDocument>(Collections.PauseNotices);

const StoredNotice = z.object({
  seq: z.number(),
  kind: z.enum(PauseNoticeKind),
  writtenAt: z.date().transform((at) => at.toISOString()),
  reason: z.enum(PauseClosedReason).optional(),
  closedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  previousExpiresAt: z.string().optional(),
  launch: z.string().optional(),
  errorCode: z.string().optional(),
});

const StoredMailbox = z.object({
  tenantId: z.string(),
  pauseId: z.string(),
  recipient: z.string(),
  notices: z.array(StoredNotice),
  delivered: z.number(),
  attempts: z.number(),
  nextAttemptAt: z.date(),
  headWrittenAt: z
    .date()
    .nullable()
    .transform((at) => at?.toISOString()),
  isDead: z.boolean(),
  problem: z
    .string()
    .nullish()
    .transform((problem) => problem ?? undefined),
});

/** A mailbox as the contract has it: its times as the contract names them. */
export const mailboxOf = (found: unknown): PauseMailbox => StoredMailbox.parse(found);

/** A text as a literal of an update pipeline: one that starts with `$` is no field path. */
const literal = (value: string): Document => ({ $literal: value });

const NOTICES: Document = { $ifNull: ["$notices", []] };

/** Whether the mailbox has no notice left undelivered (a missing one has none). */
const IS_IDLE: Document = {
  $eq: [{ $ifNull: ["$delivered", 0] }, { $size: NOTICES }],
};

/** `field` as it is, `fallback` for a missing or null one. */
const orElse = (field: string, fallback: unknown): Document => ({
  $ifNull: [`$${field}`, fallback],
});

/** The notice as an expression: its texts as literals, its time a Date, its `seq` the next place. */
function noticeExpression(planned: PlannedNotice): Document {
  const fields = Object.entries(planned.notice).flatMap(([key, value]) =>
    typeof value === "string" ? [[key, literal(value)] as const] : [],
  );
  const writtenAt = new Date(planned.notice.writtenAt);
  const seq = { $add: [{ $size: NOTICES }, 1] };
  return { ...Object.fromEntries(fields), writtenAt, seq };
}

/**
 * The append as one update stage (V3.1, #935 rule 1): a pipeline has no `$setOnInsert`, so every
 * starting field is set with `$ifNull`, and a missing `notices` is read as `[]` (`$concatArrays` of a
 * missing field is `null`). Every expression reads the document as it was before this stage: the
 * head rule — an append to a mailbox with nothing undelivered makes the new notice the head and
 * the mailbox due now; behind an undelivered head it changes neither — and `seq` see one state.
 */
export function appendStage(
  site: { readonly tenantId: string; readonly pauseId: string },
  planned: PlannedNotice,
): Document {
  const writtenAt = new Date(planned.notice.writtenAt);
  const head = (idle: unknown, kept: Document): Document => ({ $cond: [IS_IDLE, idle, kept] });
  return {
    $set: {
      tenantId: orElse("tenantId", literal(site.tenantId)),
      pauseId: orElse("pauseId", literal(site.pauseId)),
      recipient: orElse("recipient", literal(planned.recipient)),
      delivered: orElse("delivered", 0),
      isDead: orElse("isDead", false),
      claimToken: orElse("claimToken", null),
      claimedUntil: orElse("claimedUntil", null),
      attempts: head(0, orElse("attempts", 0)),
      problem: head(null, orElse("problem", null)),
      headWrittenAt: head(writtenAt, orElse("headWrittenAt", null)),
      nextAttemptAt: head(planned.at, orElse("nextAttemptAt", null)),
      notices: {
        $concatArrays: [NOTICES, [noticeExpression(planned)]],
      },
    },
  };
}

/**
 * Appends `planned` to its mailbox (made when absent): one pipeline update, an upsert by `_id` with
 * no filter on the notices, so it cannot collide — a concurrent insert of the same mailbox is a
 * write conflict of the transaction, which the driver runs again, never an `E11000` to catch.
 */
export async function appendNotice(
  db: Db,
  session: ClientSession | undefined,
  site: { readonly tenantId: string; readonly pauseId: string },
  planned: PlannedNotice,
): Promise<void> {
  const _id = mailboxIdOf(site.tenantId, site.pauseId, planned.recipient);
  await mailboxesOf(db).updateOne({ _id }, [appendStage(site, planned)], { upsert: true, session });
}
