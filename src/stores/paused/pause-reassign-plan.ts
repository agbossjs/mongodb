import { PauseNoticeKind, recipientKeysOf, replacementStepKeyOf } from "@agboss/core/stores";
import type {
  PauseInPlaceReassignment,
  PauseReassignmentChange,
  PauseRecipients,
  PauseReplacement,
  PauseSeen,
} from "@agboss/core/stores";
import { PauseStatus, type PauseRecord, type PauseTrailRecord } from "@agboss/core";
import { closedNotices, type PlannedNotice } from "./pause-changes.js";
import { reassignedPause, replacementPause } from "./pause-replacement.js";

/**
 * The plan of a reassignment (agbossjs/agboss#946, #1307): the pause row-locked and read, what the
 * change makes of it, as the core's pure `reassignChange` does (restated: the stores entry does not export
 * it) — the pause as it was seen, open at `at` (an expiry's: due), under its limits; then the
 * pause changed in place, or closed `Reassigned` with its replacement.
 */

/** What a reassignment writes: the pause as it becomes, its notices, and the replacement it inserts. */
export interface ReassignChange {
  readonly pause: PauseRecord;
  readonly notices: readonly PlannedNotice[];
  readonly inserted?: PauseRecord;
}

const NEVER = "\uffff";
const DEADLINE_KEYS: readonly string[] = ["expiresAt", "expiryBound", "remindAt"];

const isInPlace = (change: PauseReassignmentChange): change is PauseInPlaceReassignment =>
  !("pauseId" in change);

const countOf = (pause: PauseRecord, action: PauseTrailRecord["action"]): number =>
  pause.trail.filter((entry) => entry.action === action).length;

const sameAssignees = (
  one: readonly string[] | undefined,
  other: readonly string[] | undefined,
): boolean =>
  one === undefined || other === undefined
    ? one === other
    : one.length === other.length && one.every((key, index) => key === other[index]);

/** Whether the pause is still the one the change was permitted and planned against. */
const isAsSeen = (pause: PauseRecord, seen: PauseSeen | undefined): boolean =>
  seen === undefined ||
  (pause.trail.length === seen.trailLength &&
    pause.expiresAt === seen.expiresAt &&
    sameAssignees(pause.assignees, seen.assignees));

/** Whether the change may apply: as seen, open (or due, for an expiry's), under its limits. */
function isApplicable(pause: PauseRecord, change: PauseReassignmentChange, at: Date): boolean {
  if (pause.status !== PauseStatus.Pending || !isAsSeen(pause, change.seen)) return false;
  const deadline = pause.expiresAt ?? NEVER;
  if (change.due === undefined ? deadline <= at.toISOString() : deadline > at.toISOString())
    return false;
  if (
    change.maxReassignments !== undefined &&
    countOf(pause, "reassigned") >= change.maxReassignments
  )
    return false;
  return !(
    change.countsAsExtension === true &&
    change.maxExtensions !== undefined &&
    countOf(pause, "timeout-changed") >= change.maxExtensions
  );
}

/** The recipients of the old pause's `closed`: its channel only — listeners hear `reassigned`. */
const channelOnly = (recipients: PauseRecipients): PauseRecipients => ({
  ...(recipients.channel === undefined ? {} : { channel: recipients.channel }),
  listeners: [],
});

/** The entry an in-place reassignment adds to the chain of custody. */
function inPlaceEntryOf(
  pause: PauseRecord,
  change: PauseInPlaceReassignment,
  expiresAt: string | undefined,
  at: Date,
): PauseTrailRecord {
  const { assignees, actor, reason } = change;
  return {
    action: "reassigned",
    at: at.toISOString(),
    ...(actor === undefined ? {} : { actor }),
    target: pause.target,
    ...(pause.channel === undefined ? {} : { channel: pause.channel }),
    ...(assignees === undefined ? {} : { assignees }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(pause.externalRef === undefined ? {} : { externalRef: pause.externalRef }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** The pause as an in-place reassignment leaves it. */
function reassignedInPlace(
  pause: PauseRecord,
  change: PauseInPlaceReassignment,
  at: Date,
): PauseRecord {
  const deadline = change.due ?? change.timeout;
  const expiresAt = deadline === undefined ? pause.expiresAt : deadline.expiresAt;
  const dropped = ["assignees", ...(deadline === undefined ? [] : DEADLINE_KEYS)];
  const entry = inPlaceEntryOf(pause, change, expiresAt, at);
  return {
    ...(Object.fromEntries(
      Object.entries(pause).filter(([key]) => !dropped.includes(key)),
    ) as PauseRecord),
    ...deadline,
    ...(change.assignees === undefined ? {} : { assignees: change.assignees }),
    trail: [
      ...pause.trail,
      entry,
      ...(change.countsAsExtension === true
        ? [{ ...entry, action: "timeout-changed" as const }]
        : []),
    ],
  };
}

/** The `reassigned` notice of an in-place change, to the channel that sent the pause and the listeners. */
function inPlaceNotices(
  before: PauseRecord,
  after: PauseRecord,
  at: Date,
  recipients: PauseRecipients,
): readonly PlannedNotice[] {
  if (!before.isSent) return [];
  const notice = {
    kind: PauseNoticeKind.Reassigned,
    writtenAt: at.toISOString(),
    ...(after.expiresAt === undefined ? {} : { expiresAt: after.expiresAt }),
    ...(before.expiresAt === undefined ? {} : { previousExpiresAt: before.expiresAt }),
    ...(after.assignees === undefined ? {} : { assignees: after.assignees }),
    ...(before.assignees === undefined ? {} : { previousAssignees: before.assignees }),
    previousTarget: before.target,
    ...(before.channel === undefined ? {} : { previousChannel: before.channel }),
    ...(before.externalRef === undefined ? {} : { previousExternalRef: before.externalRef }),
  };
  return recipientKeysOf(recipients, PauseNoticeKind.Reassigned).map((recipient) => ({
    recipient,
    at,
    notice,
  }));
}

/** The replacement: the old pause closed `Reassigned` (its `closed` to its channel), the new one inserted unsent. */
function replacementPlan(
  pause: PauseRecord,
  replacement: PauseReplacement,
  takenStepKeys: ReadonlySet<string>,
  at: Date,
  recipients: PauseRecipients,
): ReassignChange {
  const stepKey = replacementStepKeyOf(pause, takenStepKeys);
  const closed = reassignedPause(pause, replacement.pauseId, at);
  return {
    pause: closed,
    notices: pause.isSent ? closedNotices(closed, at, channelOnly(recipients)) : [],
    inserted: replacementPause(pause, { ...replacement, stepKey }, at),
  };
}

/** What the reassignment makes of `pause`; `undefined` when it does not apply. */
export function reassignChange(
  pause: PauseRecord,
  change: PauseReassignmentChange,
  takenStepKeys: ReadonlySet<string>,
  at: Date,
  recipients: PauseRecipients,
): ReassignChange | undefined {
  if (!isApplicable(pause, change, at)) return undefined;
  if (!isInPlace(change)) return replacementPlan(pause, change, takenStepKeys, at, recipients);
  const after = reassignedInPlace(pause, change, at);
  return { pause: after, notices: inPlaceNotices(pause, after, at, recipients) };
}
