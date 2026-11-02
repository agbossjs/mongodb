import {
  PauseAnswerer,
  PauseResolution,
  PauseStatus,
  type PausedExecution,
  type PauseRecord,
} from "@agboss/core";
import { z } from "zod";
import type { PauseAnswerRecord as PauseAnswer } from "@agboss/core";

/**
 * The framework's records a store keeps as JSON — a resolved pause's log entry, a pause, a paused
 * run — checked when read back: the fields the framework relies on, the rest passed through as
 * written (the framework wrote them). A row that is not one fails loudly, never half-read.
 */

const text = z.string();
const optionalText = text.optional();

const StoredComponent = z.looseObject({ name: text, kind: text });

const StoredPauseAnswer = z.looseObject({
  pauseId: optionalText,
  executionId: text,
  step: z.looseObject({
    component: StoredComponent,
    nodeId: text,
    visitNumber: z.number(),
    idempotencyKey: text,
    copyNumber: z.number(),
    validationAttempts: z.number(),
  }),
  role: text,
  answeredBy: z.enum(PauseAnswerer),
  responder: optionalText,
  resolution: z.enum(PauseResolution),
  askedAt: text,
  resolvedAt: optionalText,
});

const StoredPause = z.looseObject({
  pauseId: text,
  tenantId: text,
  threadId: text,
  rootExecutionId: text,
  executionId: text,
  workflow: text,
  stepKey: text,
  nodeId: text,
  visitNumber: z.number(),
  copyNumber: z.number(),
  agent: text,
  channel: text,
  answeredBy: z.enum(PauseAnswerer),
  ask: z.looseObject({ callId: text, tool: text, summary: text }),
  status: z.enum(PauseStatus),
  isSent: z.boolean(),
  askedAt: text,
  resolution: z.enum(PauseResolution).optional(),
  resolvedAt: optionalText,
});

/** A paused run: the fields a resume relies on (`budgetUsd` may be `Infinity`: no cost limit). */
const StoredRun = z.looseObject({
  status: z.literal("paused"),
  threadId: text,
  tenantId: text,
  runId: text,
  ternId: text,
  budgetUsd: z.custom<number>((value) => typeof value === "number" && !Number.isNaN(value)),
});

const isPauseAnswer = (value: unknown): value is PauseAnswer =>
  StoredPauseAnswer.safeParse(value).success;

const isPauseRecord = (value: unknown): value is PauseRecord =>
  StoredPause.safeParse(value).success;

const isPausedRun = (value: unknown): value is PausedExecution["run"] =>
  StoredRun.safeParse(value).success;

/** Why a stored value is refused: what it should have been, and the value. */
const unreadable = (what: string, value: unknown): Error =>
  new Error(`a stored ${what} is not readable: ${JSON.stringify(value)}`);

/** A resolved pause's log entry, from the JSON `savePauseAnswer` wrote. */
export function pauseAnswerOfJson(json: string): PauseAnswer {
  const value: unknown = JSON.parse(json);
  if (!isPauseAnswer(value)) throw unreadable("pause answer", value);
  return value;
}

/** A pause, from the record its document keeps (parsed). */
export function pauseRecordOf(value: unknown): PauseRecord {
  if (!isPauseRecord(value)) throw unreadable("pause", value);
  return value;
}

/** JSON keeps no `Infinity` (a run without a cost limit has `budgetUsd: Infinity`): tagged. */
const NonFinite = z.object({ $number: z.enum(["Infinity", "-Infinity", "NaN"]) });

/** A paused run as text, its non-finite numbers tagged. */
export const pausedRunJsonOf = (run: PausedExecution["run"]): string =>
  JSON.stringify(run, (_key, item: unknown) =>
    typeof item === "number" && !Number.isFinite(item) ? { $number: String(item) } : item,
  );

/** A paused run, from the text `pausedRunJsonOf` wrote. */
export function pausedRunOfJson(json: string): PausedExecution["run"] {
  const value: unknown = JSON.parse(json, (_key, item: unknown) => {
    const tagged = NonFinite.safeParse(item);
    return tagged.success ? Number(tagged.data.$number) : item;
  });
  if (!isPausedRun(value)) throw unreadable("paused run", value);
  return value;
}
