import {
  PauseResolution,
  PauseStatus,
  type PauseRecord,
  type PauseTrailRecord,
} from "@agboss/core";
import type { PauseReplacement } from "@agboss/core/stores";

/**
 * A reassigned pause and its replacement (agbossjs/agboss#946, #1307): the records a reassignment
 * makes, restated from the core's pure transition (`pause-replacement.ts`), which no public entry
 * exports yet. The step key of a replacement is the core's `replacementStepKeyOf`.
 */

/** What a replacement is made from: the change and the step key the store picked. */
export type ReplacementOf = PauseReplacement & { readonly stepKey: string };

/** The pause moved to a replacement: `Cancelled`, `Reassigned`, pointing at it. */
export const reassignedPause = (
  pause: PauseRecord,
  replacementId: string,
  at: Date,
): PauseRecord => ({
  ...pause,
  status: PauseStatus.Cancelled,
  resolution: PauseResolution.Reassigned,
  resolvedAt: at.toISOString(),
  reassignedTo: replacementId,
});

/** The entry a reassignment adds to the chain of custody: who moved the pause, when, to whom, why. */
function reassignedEntryOf(
  pause: PauseRecord,
  replacement: ReplacementOf,
  at: Date,
): PauseTrailRecord {
  const { assignees, actor, reason, due, timeout, to } = replacement;
  const deadline = due ?? timeout;
  const expiresAt = deadline === undefined ? pause.expiresAt : deadline.expiresAt;
  const channel = to === undefined ? pause.channel : to.channel;
  return {
    action: "reassigned",
    at: at.toISOString(),
    ...(actor === undefined ? {} : { actor }),
    target: to === undefined ? pause.target : to.target,
    ...(channel === undefined ? {} : { channel }),
    ...(assignees === undefined ? {} : { assignees }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** The old pause without what a replacement does not keep: its reference, assignees, channel, and a replaced deadline. */
function keptOf(pause: PauseRecord, isNewDeadline: boolean): PauseRecord {
  const dropped: readonly string[] = [
    "externalRef",
    "assignees",
    "channel",
    ...(isNewDeadline ? ["expiresAt", "expiryBound", "remindAt"] : []),
  ];
  // the fields dropped are optional ones: what is left is still a record
  return Object.fromEntries(
    Object.entries(pause).filter(([key]) => !dropped.includes(key)),
  ) as PauseRecord;
}

/** Where a replacement waits: the destination's target and respondent, or the old pause's own channel. */
function placeOf(pause: PauseRecord, to: PauseReplacement["to"]): Partial<PauseRecord> {
  if (to === undefined) return pause.channel === undefined ? {} : { channel: pause.channel };
  return {
    target: to.target,
    respondent: to.respondent,
    ...(to.channel === undefined ? {} : { channel: to.channel }),
  };
}

/**
 * The pause that takes the place of `pause` for other addressees: `Pending` and unsent, its channel
 * asked again; the deadline, the branches and the question are the old pause's unless an expiry or
 * an operator set a new deadline; its chain of custody is the old one's and a `reassigned` entry.
 */
export function replacementPause(
  pause: PauseRecord,
  replacement: ReplacementOf,
  at: Date,
): PauseRecord {
  const { pauseId, assignees, stepKey, due, timeout, to } = replacement;
  return {
    ...keptOf(pause, due !== undefined || timeout !== undefined),
    ...due,
    ...timeout,
    ...placeOf(pause, to),
    pauseId,
    ...(assignees === undefined ? {} : { assignees }),
    stepKey,
    status: PauseStatus.Pending,
    isSent: false,
    askedAt: at.toISOString(),
    reassignedFrom: pause.pauseId,
    trail: [...pause.trail, reassignedEntryOf(pause, replacement, at)],
  };
}
