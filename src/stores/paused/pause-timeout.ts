import type { PauseRecord, PauseTrailRecord } from "@agboss/core";
import {
  isSeenAs,
  PauseExpiryBound,
  PauseNoticeKind,
  type PauseRecipients,
  type PauseTimeoutChange,
} from "@agboss/core/stores";
import { noticesOf, type PauseChange } from "./pause-changes.js";
import { isWithinCap } from "./pause-limits.js";

/**
 * The change of a pending pause's deadline (`app.setPauseTimeout`, agbossjs/agboss#1307), as the
 * core's pure `timeoutChange` plans it (restated: the stores entry does not export it). The filter
 * of the write (`PauseGuards.changeable`) decides what a read cannot: pending, open at `at`, the
 * stored deadline still the one the caller read; this decides the rest over the record read in the
 * same transaction — the pause as it was seen, a deadline after `at` or none, the cap, the count.
 */

/** The `timeout-changed` entries the chain holds. */
const changesOf = (pause: PauseRecord): number =>
  pause.trail.filter((entry) => entry.action === "timeout-changed").length;

/**
 * Whether the change applies to the pause as read: still as seen, to none or a time after `at`
 * (never a past one), within the record's own `maxExpiresAt`, under the record's own
 * `escalationLimits.maxExtensions` — never the caller's say, never the application's configuration.
 */
function isChangeable(pause: PauseRecord, change: PauseTimeoutChange, at: Date): boolean {
  if (pause.expiresAt !== change.previousExpiresAt || !isSeenAs(pause, change.seen)) return false;
  if (change.expiresAt !== undefined && change.expiresAt <= at.toISOString()) return false;
  if (!isWithinCap(pause.maxExpiresAt, change.expiresAt)) return false;
  return changesOf(pause) < (pause.escalationLimits.maxExtensions ?? Infinity);
}

/**
 * The source of the deadline after a change: the pause's own — except one set exactly to the
 * deadline the pause was made under, which keeps that deadline's source.
 */
function boundOf(pause: PauseRecord, change: PauseTimeoutChange): PauseExpiryBound {
  const { expiryBound } = pause;
  const isBound = change.expiresAt !== undefined && change.expiresAt === pause.boundAt;
  return isBound && expiryBound !== undefined ? expiryBound : PauseExpiryBound.Pause;
}

/** The entry a deadline change adds to the chain of custody: who moved it, when, to what, why. */
function timeoutChangedEntryOf(
  pause: PauseRecord,
  change: PauseTimeoutChange,
  at: Date,
): PauseTrailRecord {
  return {
    action: "timeout-changed",
    at: at.toISOString(),
    ...(change.actor === undefined ? {} : { actor: change.actor }),
    target: pause.target,
    ...(pause.channel === undefined ? {} : { channel: pause.channel }),
    ...(pause.assignees === undefined ? {} : { assignees: pause.assignees }),
    ...(change.expiresAt === undefined ? {} : { expiresAt: change.expiresAt }),
    ...(pause.externalRef === undefined ? {} : { externalRef: pause.externalRef }),
    ...(change.reason === undefined ? {} : { reason: change.reason }),
  };
}

/**
 * A pending pause's deadline changed: later, earlier, set or taken away — never to a past time —
 * and only from the deadline the caller read. `undefined` when it does not apply. The `timeout-changed`
 * notice names the change's own actor and reason, so a late delivery tells its own change.
 */
export function timeoutChange(
  before: PauseRecord,
  change: PauseTimeoutChange,
  at: Date,
  recipients: PauseRecipients,
): PauseChange | undefined {
  if (!isChangeable(before, change, at)) return undefined;
  const after: PauseRecord = {
    ...before,
    expiresAt: change.expiresAt,
    expiryBound: boundOf(before, change),
    remindAt: change.remindAt,
    trail: [...before.trail, timeoutChangedEntryOf(before, change, at)],
  };
  const facts = {
    ...(change.expiresAt === undefined ? {} : { expiresAt: change.expiresAt }),
    ...(before.expiresAt === undefined ? {} : { previousExpiresAt: before.expiresAt }),
    ...(change.actor === undefined ? {} : { actor: change.actor }),
    ...(change.reason === undefined ? {} : { changeReason: change.reason }),
  };
  return {
    pause: after,
    notices: noticesOf(recipients, PauseNoticeKind.TimeoutChanged, at, facts),
  };
}
