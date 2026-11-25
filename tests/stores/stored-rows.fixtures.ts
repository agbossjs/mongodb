import { readFileSync } from "node:fs";

/** What 0.1.1 writes as JSON: a pause, an answer-log entry, a kept history record, a paused run. */

export const STEP = {
  component: { name: "clerk-agent", kind: "agent" },
  nodeId: "clerk-agent",
  visitNumber: 1,
  idempotencyKey: "run-1:s:1",
  copyNumber: 1,
  validationAttempts: 0,
};

/** A pause row's JSON: `respondent` is who may answer. */
export const pauseJson = JSON.stringify({
  threadId: "t-1",
  executionId: "run-1",
  workflow: "desk-workflow",
  nodeId: "clerk-agent",
  visitNumber: 1,
  copyNumber: 1,
  askedAt: "2026-01-05T09:00:00.000Z",
  kind: "approval",
  step: "clerk-agent",
  component: { name: "clerk-agent", kind: "agent" },
  target: "refund-tool-approval",
  channel: "refund-approval-channel",
  respondent: "delegate",
  input: { orderId: "7" },
  toolCall: { callId: "call-1", tool: "refund", summary: "refund 7" },
});

/** One `PauseAnswerRecord`: `respondent` the kind, `actor` the person. */
export const answerEntry = (
  executionId: string,
  kind: string,
  person: string,
): Record<string, unknown> => ({
  pauseId: undefined,
  executionId,
  step: STEP,
  target: "refund-tool-approval",
  channel: "refund-approval-channel",
  respondent: kind,
  actor: { id: person },
  resolution: "replied",
  askedAt: "2026-01-05T09:00:00.000Z",
  resolvedAt: "2026-01-05T09:05:00.000Z",
  decision: { approved: true },
  input: { text: "10 USD" },
  trail: [{ action: "opened", at: "2026-01-05T09:00:00.000Z", target: "refund-approval-channel" }],
});

export const answerLogEntry = answerEntry("run-1", "delegate", "manager-17");

/** A kept record's tree: what a test reaches into. */
export interface RecordTree {
  pauses: unknown[];
  children: RecordTree[];
  [field: string]: unknown;
}

const RECORD_TEXT = readFileSync(new URL("./history-record.json", import.meta.url), "utf8");

/**
 * An `ExecutionHistoryRecord` in full (`history-record.json`): the root's pauses, a child's, and the
 * child's child's; each usage names its provider.
 */
export const historyRecord: Record<string, unknown> = JSON.parse(RECORD_TEXT);

/** A fresh copy of the record, changed by `change`. */
export function historyRecordWith(change: (tree: RecordTree) => void): RecordTree {
  const tree: RecordTree = JSON.parse(RECORD_TEXT);
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

/** A paused run (`paused-run.json`): `turnId`, a pending approval, a launch's group by `targets`. */
export const pausedRun: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("./paused-run.json", import.meta.url), "utf8"),
);
