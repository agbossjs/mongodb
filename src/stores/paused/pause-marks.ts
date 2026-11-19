import { PauseResolution, PauseStatus, type PauseRecord } from "@agboss/core";
import { PauseNoticeKind, type PauseNoticeFacts, type PauseRecipients } from "@agboss/core/stores";
import {
  closedNotices,
  noticesOf,
  untakenNotices,
  type PauseChange,
  type PlannedNotice,
} from "./pause-changes.js";

/** The instant of a record's time text; a record stored before `askedAt` (empty) is the epoch. */
function instantOf(text: string | undefined): Date {
  // no text is an invalid date, as an unparsable one is: both read as the epoch
  const instant = new Date(text ?? Number.NaN);
  return Number.isNaN(instant.getTime()) ? new Date(0) : instant;
}

/**
 * The channel was asked (rule 2): `isSent` whatever the status, and — only when it was not yet —
 * `opened` to the listeners, then, when the pause closed meanwhile, its `closed` to the channel and
 * the listeners, then its `answerNotTaken` when its answer was closed untaken (I8). The notices
 * carry the times the record knows (`askedAt`, `resolvedAt` / `expiresAt`): `markSent` has no `at`.
 */
export function markSentChange(pause: PauseRecord, recipients: PauseRecipients): PauseChange {
  if (pause.isSent) return { pause, notices: [] };
  const expiry = pause.expiresAt === undefined ? {} : { expiresAt: pause.expiresAt };
  const asked = instantOf(pause.askedAt);
  const opened = noticesOf(recipients, PauseNoticeKind.Opened, asked, expiry);
  const sent = { ...pause, isSent: true };
  if (pause.status === PauseStatus.Pending) return { pause: sent, notices: opened };
  const first = pause.closedFirst ?? pause;
  const closedAt = instantOf(first.resolvedAt ?? pause.askedAt);
  const resolution = pause.resolution;
  const isUntaken =
    pause.answer !== undefined &&
    (resolution === PauseResolution.Cancelled || resolution === PauseResolution.TreeEnded);
  const untaken = isUntaken
    ? untakenNotices(resolution, instantOf(pause.resolvedAt), recipients)
    : [];
  return {
    pause: sent,
    notices: [...opened, ...closedNotices(pause, closedAt, recipients), ...untaken],
  };
}

/** A notice of `kind` for a pause in any status, once the pause is sent (`noticeOnce…`). */
export function onceNotices(
  pause: PauseRecord,
  kind: PauseNoticeKind,
  facts: PauseNoticeFacts,
  at: Date,
  recipients: PauseRecipients,
): readonly PlannedNotice[] {
  return pause.isSent ? noticesOf(recipients, kind, at, facts) : [];
}
