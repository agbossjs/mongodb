import {
  PauseAnswerer,
  PauseKind,
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
  // agbossjs/agboss#801: stored as written, never inferred (`pauseFieldsOfVersion` reads an older record)
  kind: z.enum(PauseKind),
  step: text,
  channel: text,
  answeredBy: z.enum(PauseAnswerer),
  // an approval's tool call, or a question role's own ask (agbossjs/agboss#659, #712): `kind` says
  ask: z.looseObject({}),
  component: StoredComponent.optional(),
  status: z.enum(PauseStatus),
  isSent: z.boolean(),
  askedAt: text,
  resolution: z.enum(PauseResolution).optional(),
  resolvedAt: optionalText,
});

/** The tool call an approval's pause asks about. */
const StoredApprovalAsk = z.looseObject({ callId: text, tool: text, summary: text });

/** agbossjs/agboss#746: a question's ask is the role's own DTO; an approval's is a tool call. */
const isAskOfItsKind = (pause: z.infer<typeof StoredPause>): boolean =>
  pause.kind === PauseKind.Question || StoredApprovalAsk.safeParse(pause.ask).success;

/** A paused run: the fields a resume relies on (`budgetUsd` may be `Infinity`: no cost limit). */
const StoredRun = z.looseObject({
  status: z.literal("paused"),
  threadId: text,
  tenantId: text,
  runId: text,
  turnId: optionalText,
  // a run stored by 0.1.0 names its record `ternId` ("Tern" was a misspelling of "turn", #906)
  ternId: optionalText,
  budgetUsd: z.custom<number>((value) => typeof value === "number" && !Number.isNaN(value)),
});

/** The ids that name a stored value in an error: its keys, never its content. */
/** ` (tenantId acme, …)`, or nothing when no id is readable. */
const named = (ids: string): string => (ids === "" ? "" : ` (${ids})`);

const idsOf = (value: unknown, keys: readonly string[]): string =>
  keys
    .flatMap((key) => {
      const id: unknown =
        typeof value === "object" && value !== null ? Reflect.get(value, key) : "";
      return typeof id === "string" ? [`${key} ${id}`] : [];
    })
    .join(", ");

/**
 * Why a stored value is refused (#906 D4): what it should have been, the ids that name it and the
 * field that failed — never the value, whose input and data are the caller's (PII reaches the logs
 * through a message). The schema's own error, which names paths and expectations only, is the `cause`.
 */
function unreadable(
  what: string,
  keys: readonly string[],
  value: unknown,
  failure: { readonly error?: z.ZodError; readonly field?: string },
): Error {
  const field =
    failure.field ??
    [
      ...new Set(
        (failure.error?.issues ?? []).map((issue) => issue.path.join(".") || "(the value)"),
      ),
    ].join(", ");
  return new Error(
    `a stored ${what} is not readable${named(idsOf(value, keys))}: the field(s) ${field === "" ? "(the value)" : field} missing or not what the framework wrote`,
    { cause: failure.error },
  );
}

const ANSWER_IDS = ["pauseId", "executionId"];
const PAUSE_IDS = ["pauseId", "tenantId", "executionId"];
const RUN_IDS = ["threadId", "runId"];

/** A resolved pause's log entry, from the JSON `savePauseAnswer` wrote. */
export function pauseAnswerOfJson(json: string): PauseAnswer {
  const value: unknown = JSON.parse(json);
  const stored = StoredPauseAnswer.safeParse(value);
  if (!stored.success) throw unreadable("pause answer", ANSWER_IDS, value, { error: stored.error });
  return value as PauseAnswer;
}

/** A pause, from the record its document keeps (parsed). */
export function pauseRecordOf(value: unknown): PauseRecord {
  const stored = StoredPause.safeParse(value);
  if (!stored.success) throw unreadable("pause", PAUSE_IDS, value, { error: stored.error });
  if (!isAskOfItsKind(stored.data)) {
    const ask = StoredApprovalAsk.safeParse(stored.data.ask);
    throw unreadable("pause", PAUSE_IDS, value, { error: ask.error, field: "ask" });
  }
  return value as PauseRecord;
}

/** JSON keeps no `Infinity` (a run without a cost limit has `budgetUsd: Infinity`): tagged. */
const NonFinite = z.object({ $number: z.enum(["Infinity", "-Infinity", "NaN"]) });

/** A paused run as text, its non-finite numbers tagged. */
export const pausedRunJsonOf = (run: PausedExecution["run"]): string =>
  JSON.stringify(run, (_key, item: unknown) =>
    typeof item === "number" && !Number.isFinite(item) ? { $number: String(item) } : item,
  );

/** The run with its record's id as `turnId`: a run stored by 0.1.0 has it as `ternId` (#906). */
function withTurnId(run: PausedExecution["run"]): PausedExecution["run"] {
  const legacy: unknown = Reflect.get(run, "ternId");
  if (typeof legacy !== "string") return run;
  const turnId: unknown = Reflect.get(run, "turnId");
  const current = { ...run, turnId: typeof turnId === "string" ? turnId : legacy };
  Reflect.deleteProperty(current, "ternId");
  return current;
}

/** A paused run, from the text `pausedRunJsonOf` wrote (one stored by 0.1.0 under `ternId` too). */
export function pausedRunOfJson(json: string): PausedExecution["run"] {
  const value: unknown = JSON.parse(json, (_key, item: unknown) => {
    const tagged = NonFinite.safeParse(item);
    return tagged.success ? Number(tagged.data.$number) : item;
  });
  const stored = StoredRun.safeParse(value);
  if (!stored.success) throw unreadable("paused run", RUN_IDS, value, { error: stored.error });
  if ((stored.data.turnId ?? stored.data.ternId) === undefined)
    throw unreadable("paused run", RUN_IDS, value, { field: "turnId" });
  return withTurnId(value as PausedExecution["run"]);
}
