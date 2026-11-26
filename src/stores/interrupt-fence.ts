import { ExecutionPauseFencedError, ExecutionStopFencedError } from "@agboss/core/internal";
import type { CancelFencedKey } from "@agboss/core/stores";

/**
 * The refusals of a write after its tree's `Immediate` pause or stop (#1341b, #1341c). The core's
 * `@agboss/core/stores` has `cancelFencedOf(key)` for a cancel only: the two abort reasons the
 * holder reads as a pause and as a stop are classes of `@agboss/core/internal` until the core
 * exports a seam for them (reported on agbossjs/agboss#1324; the one file `eslint.config.js` allows
 * that import in). Nothing else here reaches the core's internals.
 */

/** The pause's refusal of the write `key` names: the holder parks the tree as paused. */
export const pauseFencedOf = (key: CancelFencedKey): Error => ExecutionPauseFencedError.of(key);

/** The stop's refusal of the write `key` names: the holder stops the tree as stopped. */
export const stopFencedOf = (key: CancelFencedKey): Error => ExecutionStopFencedError.of(key);
