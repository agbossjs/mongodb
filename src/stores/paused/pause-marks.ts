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

/** The pause once its channel was asked: `isSent`, and the reference the channel's system gave it, also on its newest chain-of-custody entry. */
export function sentPause(pause: PauseRecord, externalRef: string | undefined): PauseRecord {
  if (externalRef === undefined) return { ...pause, isSent: true };
  const last = pause.trail.at(-1);
  return {
    ...pause,
    isSent: true,
    externalRef,
    trail: [...pause.trail.slice(0, -1), ...(last === undefined ? [] : [{ ...last, externalRef }])],
  };
}

/**
 * The notices of a pause whose channel was just asked: `opened` to the listeners; for a replacement a
 * reassignment made, `reassigned` to the listeners instead (its channel was sent it, the old pause's
 * channel was told `closed`), naming what it moved from — the entry before its own in the chain.
 */
function openingNotices(
  pause: PauseRecord,
  sent: PauseRecord,
  recipients: PauseRecipients,
): readonly PlannedNotice[] {
  const asked = instantOf(pause.askedAt);
  if (pause.reassignedFrom === undefined)
    return noticesOf(
      recipients,
      PauseNoticeKind.Opened,
      asked,
      pause.expiresAt === undefined ? {} : { expiresAt: pause.expiresAt },
    );
  const before = pause.trail.at(-2);
  return noticesOf(
    { listeners: recipients.listeners },
    PauseNoticeKind.Reassigned,
    asked,
    definedOf({
      expiresAt: pause.expiresAt,
      previousExpiresAt: before?.expiresAt,
      assignees: sent.assignees,
      previousAssignees: before?.assignees,
      previousTarget: before?.target,
      previousChannel: before?.channel,
      previousExternalRef: before?.externalRef,
    }),
  );
}

/** The fields that are set: an undefined fact is no key in the notice's JSON. */
const definedOf = (facts: Readonly<Record<string, unknown>>): PauseNoticeFacts =>
  Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined));

/**
 * The channel was asked (rule 2): `isSent` whatever the status, and — only when it was not yet —
 * `opened` to the listeners, then, when the pause closed meanwhile, its `closed` to the channel and
 * the listeners, then its `answerNotTaken` when its answer was closed untaken (I8). The notices
 * carry the times the record knows (`askedAt`, `resolvedAt` / `expiresAt`): `markSent` has no `at`.
 */
export function markSentChange(
  pause: PauseRecord,
  recipients: PauseRecipients,
  externalRef?: string,
): PauseChange {
  if (pause.isSent) return { pause, notices: [] };
  const sent = sentPause(pause, externalRef);
  const opened = openingNotices(pause, sent, recipients);
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
