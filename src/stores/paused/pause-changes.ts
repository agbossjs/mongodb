import {
  PauseClosedReason,
  PauseResolution,
  PauseStatus,
  type ExpiryProblem,
  type PauseCancellation,
  type PauseRecord,
} from "@agboss/core";
import {
  closedAtOf,
  pauseClosedReasonOf,
  PauseNoticeKind,
  recipientKeysOf,
  type PauseAnswer,
  isSeenAs,
  type PauseExpiry,
  type PauseNotice,
  type PauseNoticeFacts,
  type PauseRecipients,
  type PauseSeen,
  type PauseUntakenResolution,
} from "@agboss/core/stores";

/**
 * Every transition of a pause as a pure function (#938, #910 rules 1–8): the record it makes and
 * the notices written with it. What a change needs of the clock or the deadline is NOT decided
 * here — the compare-and-set's filter decides it (`pause-guards.ts`), so no answer is ever recorded
 * at or after its deadline whatever this reads; a change that does not apply writes nothing.
 */

/** One notice to write: to whom, and the instant it is due (the transition's `at`). */
export interface PlannedNotice {
  readonly recipient: string;
  readonly at: Date;
  readonly notice: Omit<PauseNotice, "seq">;
}

/** A change of a pause with the notices that go in the same transaction. */
export interface PauseChange {
  readonly pause: PauseRecord;
  readonly notices: readonly PlannedNotice[];
}

/** The notice of `kind` to each receiver of it, due at `at`. */
export function noticesOf(
  recipients: PauseRecipients,
  kind: PauseNoticeKind,
  at: Date,
  facts: PauseNoticeFacts,
): readonly PlannedNotice[] {
  const notice = { kind, writtenAt: at.toISOString(), ...facts };
  return recipientKeysOf(recipients, kind).map((recipient) => ({ recipient, at, notice }));
}

/** The `closed` notice of a record that closed. */
export function closedNotices(
  closed: PauseRecord,
  at: Date,
  recipients: PauseRecipients,
): readonly PlannedNotice[] {
  const reason = pauseClosedReasonOf(closed, at);
  if (reason === undefined) throw new TypeError(`pause ${closed.pauseId} did not close`);
  const closedAt = closedAtOf(closed);
  return noticesOf(recipients, PauseNoticeKind.Closed, at, {
    reason,
    ...(closedAt === undefined ? {} : { closedAt }),
  });
}

/** What closing a pending pause does: its notice is written only when the pause was sent. */
export function closing(
  before: PauseRecord,
  after: PauseRecord,
  at: Date,
  who: PauseRecipients,
): PauseChange {
  return { pause: after, notices: before.isSent ? closedNotices(after, at, who) : [] };
}

/** `after` of a closed pause: its status, how and when it closed. */
export const closed = (
  pause: PauseRecord,
  fields: Pick<PauseRecord, "status" | "resolution"> & Partial<PauseRecord>,
  at: Date,
): PauseRecord => ({ ...pause, ...fields, resolvedAt: at.toISOString() });

/**
 * `Pending → Resolved` with the answer (`Replied`) — and, when the caller names the pause its permit
 * was asked over (`seen`), only while it is still that one: with no `seen` the change is unguarded
 * (as the core's `resolveChange`; the guard decides the deadline).
 */
export function resolveChange(
  before: PauseRecord,
  answer: PauseAnswer,
  at: Date,
  recipients: PauseRecipients,
  seen?: PauseSeen,
): PauseChange | undefined {
  if (seen !== undefined && !isSeenAs(before, seen)) return undefined;
  const after = closed(
    before,
    { status: PauseStatus.Resolved, answer, resolution: PauseResolution.Replied },
    at,
  );
  return closing(before, after, at, recipients);
}

/**
 * `Pending → Taken` with the answer its channel gave at once (`Decided`, no notice: the pause was
 * never sent), only while the pause is still the one the channel was sent (`seen`): an expiry's
 * in-place reassignment during the first send makes the decision stale. The guard decides the
 * deadline (an answer at or after it is the expiry's), as the core's `decideChange` does.
 */
export function decideChange(
  before: PauseRecord,
  answer: PauseAnswer,
  at: Date,
  seen: PauseSeen,
): PauseChange | undefined {
  if (!isSeenAs(before, seen)) return undefined;
  const after = closed(
    before,
    { status: PauseStatus.Taken, answer, resolution: PauseResolution.Decided },
    at,
  );
  return { pause: after, notices: [] };
}

/** `Pending → Cancelled`; a cancel or a tree end at or after `expiresAt` records `Expired` (I3). */
export function cancelChange(
  before: PauseRecord,
  resolution: PauseCancellation,
  at: Date,
  recipients: PauseRecipients,
): PauseChange {
  // no deadline is an invalid date, never due
  const isDue = new Date(before.expiresAt ?? Number.NaN).getTime() <= at.getTime();
  const isExpired = resolution !== PauseResolution.Withdrawn && isDue;
  const after = closed(
    before,
    {
      status: PauseStatus.Cancelled,
      resolution: isExpired ? PauseResolution.Expired : resolution,
    },
    at,
  );
  return closing(before, after, at, recipients);
}

/** An expiry: the channel's answer (`Resolved`, `DecidedOnExpiry`), else `Cancelled`, `Expired`. */
export function expireChange(
  before: PauseRecord,
  expiry: PauseExpiry,
  at: Date,
  recipients: PauseRecipients,
): PauseChange {
  const problem: ExpiryProblem | undefined = expiry.problem;
  const after =
    expiry.answer === undefined
      ? closed(
          before,
          {
            status: PauseStatus.Cancelled,
            resolution: PauseResolution.Expired,
            ...(problem === undefined ? {} : { expiryProblem: problem }),
          },
          at,
        )
      : closed(
          before,
          {
            status: PauseStatus.Resolved,
            answer: { ...expiry.answer, actor: undefined },
            resolution: PauseResolution.DecidedOnExpiry,
          },
          at,
        );
  return closing(before, after, at, recipients);
}

/** The `answerNotTaken` notice: why it closed and when. */
export const untakenNotices = (
  resolution: PauseUntakenResolution,
  at: Date,
  recipients: PauseRecipients,
): readonly PlannedNotice[] =>
  noticesOf(recipients, PauseNoticeKind.AnswerNotTaken, at, {
    reason:
      resolution === PauseResolution.Cancelled
        ? PauseClosedReason.Cancelled
        : PauseClosedReason.TreeEnded,
    closedAt: at.toISOString(),
  });

/** `Resolved → Cancelled`, the answer kept: its run never applied it (Q2). */
export function closeUntakenChange(
  before: PauseRecord,
  resolution: PauseUntakenResolution,
  at: Date,
  recipients: PauseRecipients,
): PauseChange {
  // the first close's resolution and time stay in `closedFirst`: the untaken close only adds its marker
  const first =
    before.resolution === undefined || before.resolvedAt === undefined
      ? {}
      : { closedFirst: { resolution: before.resolution, resolvedAt: before.resolvedAt } };
  const after = closed(before, { status: PauseStatus.Cancelled, resolution, ...first }, at);
  return { pause: after, notices: before.isSent ? untakenNotices(resolution, at, recipients) : [] };
}

/** The reminder of a pending pause, once: its `remindAt` cleared, `expiring` written. */
export function remindChange(
  before: PauseRecord,
  at: Date,
  recipients: PauseRecipients,
): PauseChange | undefined {
  if (before.expiresAt === undefined) return undefined;
  const facts = { expiresAt: before.expiresAt };
  const notices = noticesOf(recipients, PauseNoticeKind.Expiring, at, facts);
  return { pause: { ...before, remindAt: undefined }, notices };
}
