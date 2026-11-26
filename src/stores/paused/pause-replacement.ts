import { PauseResolution, PauseStatus, type PauseRecord } from "@agboss/core";

/**
 * The pause a reassignment replaced (agbossjs/agboss#946): the record it becomes. The replacement
 * itself is the core's `replacementPause` (exported from `@agboss/core/stores`: the entries of its
 * chain of custody, its narrowed limits, its step key are the core's, not restated here).
 */

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
