import type { PausedExecution, PauseAnswerRecord, PauseRecord } from "@agboss/core";
import { pauseAnswerRecordOfValue, pausedRunOfValue, pauseRecordOfJson } from "@agboss/core/stores";
import { z } from "zod";
import { parsedOrUnreadable } from "./unreadable.js";

/**
 * The framework's records a store keeps as JSON — a resolved pause's log entry, a pause, a paused
 * run — read back by the core, whole: every field checked (version tolerant: what 0.1.0 wrote reads
 * too), the record that comes out is what the schema says. A row that is not one fails with
 * `StoredNamesUnreadableError`, naming the ids and the field, never half-read.
 */

/** A resolved pause's log entry, from the JSON `savePauseAnswer` wrote (read by the core: any depth checked). */
export const pauseAnswerOfJson = (
  json: string,
  ids: { readonly executionId?: string } = {},
): PauseAnswerRecord => pauseAnswerRecordOfValue(parsedOrUnreadable("pause answer", json, ids));

/** A pause, from the record its row or document keeps (parsed), read by the core. */
export const pauseRecordOf = (value: unknown): PauseRecord => pauseRecordOfJson(value);

/** JSON keeps no `Infinity` (a run without a cost limit has `budgetUsd: Infinity`): tagged. */
const NonFinite = z.object({ $number: z.enum(["Infinity", "-Infinity", "NaN"]) });

/** A paused run as text, its non-finite numbers tagged. */
export const pausedRunJsonOf = (run: PausedExecution["run"]): string =>
  JSON.stringify(run, (_key, item: unknown) =>
    typeof item === "number" && !Number.isFinite(item) ? { $number: String(item) } : item,
  );

/** A paused run, from the text `pausedRunJsonOf` wrote (one stored by 0.1.0 under `ternId` too), read by the core. */
export function pausedRunOfJson(
  json: string,
  ids: { readonly threadId?: string; readonly runId?: string } = {},
): PausedExecution["run"] {
  return pausedRunOfValue(
    parsedOrUnreadable("paused run", json, ids, (_key, item: unknown) => {
      const tagged = NonFinite.safeParse(item);
      return tagged.success ? Number(tagged.data.$number) : item;
    }),
  );
}
