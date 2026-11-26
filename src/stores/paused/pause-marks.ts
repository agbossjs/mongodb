import {
  PauseResolution,
  PauseStatus,
  type PauseRecord,
  type PauseTrailRecord,
} from "@agboss/core";
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
 * A pause the channel was just sent that was changed in place meanwhile: its `opened` entry (the
 * first of its trail, what the channel was asked with) and the first `reassigned` entry after it.
 * Not a replacement (its own `reassigned` entry is told by `openingNotices`); `undefined` when the
 * pause was not changed in place.
 */
function inPlaceChangeOf(
  pause: PauseRecord,
): { readonly asked: PauseTrailRecord; readonly changed: PauseTrailRecord } | undefined {
  // every pause has its `opened` entry first
  const [asked, ...rest] = pause.trail as [PauseTrailRecord, ...PauseTrailRecord[]];
  const changed = rest.find((entry) => entry.action === "reassigned");
  return pause.reassignedFrom !== undefined || changed === undefined
    ? undefined
    : { asked, changed };
}

/**
 * The notices of a pause whose channel was just asked: `opened` to the listeners — with the deadline
 * the channel was asked with, not one an in-place change set during the send (`inFirstSendNotices`
 * tells that); for a replacement a reassignment made, `reassigned` to the listeners instead (its
 * channel was sent it, the old pause's channel was told `closed`), naming what it moved from — the
 * entry before its own in the chain.
 */
function openingNotices(
  pause: PauseRecord,
  sent: PauseRecord,
  recipients: PauseRecipients,
): readonly PlannedNotice[] {
  const asked = instantOf(pause.askedAt);
  if (pause.reassignedFrom === undefined) {
    const deadline = (inPlaceChangeOf(pause)?.asked ?? pause).expiresAt;
    return noticesOf(
      recipients,
      PauseNoticeKind.Opened,
      asked,
      deadline === undefined ? {} : { expiresAt: deadline },
    );
  }
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

/**
 * The `reassigned` notice of a pause that was changed in place while its first send was in flight,
 * to the channel that was just sent it and to the listeners (restated from the core's
 * `inFirstSendNotices`, which the stores entry does not export): the in-place change wrote none then
 * — nobody was told of the pause yet. It names what the channel was asked with (the `opened` entry)
 * and what the pause is now, due at the change's own time. No `previousExternalRef`: a pause not yet
 * sent has no reference.
 */
function inFirstSendNotices(
  sent: PauseRecord,
  recipients: PauseRecipients,
): readonly PlannedNotice[] {
  const change = inPlaceChangeOf(sent);
  if (change === undefined) return [];
  const { asked, changed } = change;
  return noticesOf(
    recipients,
    PauseNoticeKind.Reassigned,
    instantOf(changed.at),
    definedOf({
      expiresAt: sent.expiresAt,
      previousExpiresAt: asked.expiresAt,
      assignees: sent.assignees,
      previousAssignees: asked.assignees,
      previousTarget: asked.target,
      previousChannel: asked.channel,
    }),
  );
}

/** The fields that are set: an undefined fact is no key in the notice's JSON. */
const definedOf = (facts: Readonly<Record<string, unknown>>): PauseNoticeFacts =>
  Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined));

/**
 * The channel was asked (rule 2): `isSent` whatever the status, and — only when it was not yet —
 * `opened` to the listeners, then, when the pause was changed in place meanwhile (an expiry's
 * reassignment while the first send ran), the `reassigned` it owes its channel and listeners, then,
 * when the pause closed meanwhile, its `closed` to the channel and
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
  if (pause.status === PauseStatus.Pending)
    return { pause: sent, notices: [...opened, ...inFirstSendNotices(sent, recipients)] };
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
