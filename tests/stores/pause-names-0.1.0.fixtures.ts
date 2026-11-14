import { readFileSync } from "node:fs";

/** What 0.1.0 wrote as JSON: a pause, an answer, a log entry, a kept history record (#934). */

export const STEP = {
  component: { name: "clerk-agent", kind: "agent" },
  nodeId: "clerk-agent",
  visitNumber: 1,
  idempotencyKey: "run-1:s:1",
  copyNumber: 1,
  validationAttempts: 0,
};

/** A 0.1.0 pause: `answeredBy` is who may answer, its answer's `answerer` the person. */
export const oldPause = {
  pauseId: "p1",
  tenantId: "default",
  threadId: "t-1",
  rootExecutionId: "run-1",
  executionId: "run-1",
  workflow: "desk-workflow",
  stepKey: "run-1:s:1",
  nodeId: "clerk-agent",
  visitNumber: 1,
  copyNumber: 1,
  kind: "approval",
  step: "clerk-agent",
  channel: "refund-approval-channel",
  answeredBy: "channel",
  ask: { callId: "call-1", tool: "refund", arguments: { orderId: "7" }, summary: "refund 7" },
  status: "resolved",
  isSent: true,
  askedAt: "2026-01-05T09:00:00.000Z",
  resolution: "replied",
  resolvedAt: "2026-01-05T09:05:00.000Z",
  answer: { decision: { approved: true }, answerer: "manager-17" },
};

/** One 0.1.0 `PauseAnswerRecord`: `answeredBy` the kind, `responder` the person. */
export const oldAnswer = (
  executionId: string,
  kind: string,
  person: string,
): Record<string, unknown> => ({
  executionId,
  step: STEP,
  role: "refund-approval-channel",
  answeredBy: kind,
  responder: person,
  resolution: "replied",
  askedAt: "2026-01-05T09:00:00.000Z",
  resolvedAt: "2026-01-05T09:05:00.000Z",
  decision: { approved: true },
});

export const oldAnswerLogEntry = oldAnswer("run-1", "channel", "manager-17");

/** A kept record's tree: what a test reaches into. */
export interface RecordTree {
  pauses: unknown[];
  children: RecordTree[];
  [field: string]: unknown;
}

const OLD_TEXT = readFileSync(new URL("./history-record-0.1.0.json", import.meta.url), "utf8");

/**
 * A 0.1.0 `ExecutionHistoryRecord` in full (`history-record-0.1.0.json`: written as a typed literal
 * against the published `@agboss/core@0.1.0` declarations): the root's pauses, a child's, and the
 * child's child's.
 */
export const oldHistoryRecord: Record<string, unknown> = JSON.parse(OLD_TEXT);

/** A fresh copy of the record, changed by `change`. */
export function historyRecordWith(change: (tree: RecordTree) => void): RecordTree {
  const tree: RecordTree = JSON.parse(OLD_TEXT);
  change(tree);
  return tree;
}

/** The deepest child of a record. */
export function leafOf(tree: RecordTree): RecordTree {
  const [child] = tree.children;
  const [leaf] = child?.children ?? [];
  if (leaf === undefined) throw new TypeError("the fixture has a child's child");
  return leaf;
}

/** A paused run in the shape 0.1.0 wrote it (`paused-run-0.1.0.json`). */
export const oldPausedRun: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("./paused-run-0.1.0.json", import.meta.url), "utf8"),
);
