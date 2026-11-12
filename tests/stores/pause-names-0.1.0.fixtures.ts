/** What 0.1.0 wrote as JSON: a pause, an answer, a log entry, a kept history record (#934). */

const STEP = {
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
const oldAnswer = (executionId: string, kind: string, person: string) => ({
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

/** A 0.1.0 history record: the root's pauses, a child's, and the child's child's. */
export const oldHistoryRecord = {
  executionId: "run-1",
  rootExecutionId: "run-1",
  threadId: "t-1",
  tenantId: "default",
  application: { name: "desk", version: "1.0.0", instanceId: "i-1" },
  workflow: { name: "desk-workflow", version: "1" },
  status: "finished",
  startedAt: "2026-01-05T09:00:00.000Z",
  start: { name: "desk-workflow-start", kind: "start" },
  contexts: { tenant: {}, execution: {} },
  pauses: [oldAnswer("run-1", "channel", "manager-17")],
  children: [
    {
      executionId: "child-1",
      pauses: [oldAnswer("child-1", "thread-owner", "alice")],
      children: [
        { executionId: "child-2", pauses: [oldAnswer("child-2", "channel", "bob")], children: [] },
      ],
    },
  ],
};
