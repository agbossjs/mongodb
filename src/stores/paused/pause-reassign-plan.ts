import {
  isSeenAs,
  narrowedLimits,
  PauseNoticeKind,
  recipientKeysOf,
  replacementPause,
  replacementStepKeyOf,
} from "@agboss/core/stores";
import type {
  PauseInPlaceReassignment,
  PauseLimitsOffer,
  PauseReassignmentChange,
  PauseRecipients,
  PauseReplacement,
} from "@agboss/core/stores";
import { PauseStatus, type PauseRecord, type PauseTrailRecord } from "@agboss/core";
import { closedNotices, type PlannedNotice } from "./pause-changes.js";
import { isWithinCap } from "./pause-limits.js";
import { reassignedPause } from "./pause-replacement.js";

/**
 * The plan of a reassignment (agbossjs/agboss#946, #1307), as the core's pure `reassignChange` makes
 * it (restated: the stores entry does not export it): the pause as it was read in the transaction
 * and seen — open at `at` (an expiry's: due) — under the limits its own record holds, narrowed by the
 * destination of a move; then the pause changed in place, or closed `Reassigned` with its
 * replacement (the core's `replacementPause`). The counts and the cap come from the record read
 * here, never from the change and never from configuration: the narrowing is of this read, in the
 * same write as the insert.
 */

/** What a reassignment writes: the pause as it becomes, its notices, and the replacement it inserts. */
export interface ReassignChange {
  readonly pause: PauseRecord;
  readonly notices: readonly PlannedNotice[];
  readonly inserted?: PauseRecord;
}

const NEVER = "\uffff";
const DEADLINE_KEYS: readonly string[] = ["expiryBound", "remindAt", "expiresAt"];

const isInPlace = (change: PauseReassignmentChange): change is PauseInPlaceReassignment =>
  !("pauseId" in change);

/** The limits a move offers: none for a change in place. */
const offeredLimitsOf = (change: PauseReassignmentChange): PauseLimitsOffer | undefined =>
  isInPlace(change) ? undefined : change.to?.limits;

const countOf = (pause: PauseRecord, action: PauseTrailRecord["action"]): number =>
  pause.trail.filter((entry) => entry.action === action).length;

/**
 * Whether the change keeps the limits: the record's own, narrowed by the destination of a move —
 * never the application's configuration —, the counts and the cap on a deadline the change sets.
 */
function isUnderLimits(pause: PauseRecord, change: PauseReassignmentChange): boolean {
  const { escalationLimits, maxExpiresAt } = narrowedLimits(pause, offeredLimitsOf(change));
  const deadline = change.due ?? change.timeout;
  if (deadline !== undefined && !isWithinCap(maxExpiresAt, deadline.expiresAt)) return false;
  // no limit named: no count reaches it
  if (countOf(pause, "reassigned") >= (escalationLimits.maxReassignments ?? Infinity)) return false;
  return !(
    change.countsAsExtension === true &&
    countOf(pause, "timeout-changed") >= (escalationLimits.maxExtensions ?? Infinity)
  );
}

/** Whether the change may apply: as seen, open (or due, for an expiry's), under its limits. */
function isApplicable(pause: PauseRecord, change: PauseReassignmentChange, at: Date): boolean {
  if (pause.status !== PauseStatus.Pending || !isSeenAs(pause, change.seen)) return false;
  const deadline = pause.expiresAt ?? NEVER;
  if (change.due === undefined ? deadline <= at.toISOString() : deadline > at.toISOString())
    return false;
  return isUnderLimits(pause, change);
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
