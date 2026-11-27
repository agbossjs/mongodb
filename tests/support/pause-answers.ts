import { ComponentKind, PauseResolution, type PauseAnswerRecord } from "@agboss/core";
import { PauseRespondent } from "@agboss/core/stores";

/** A resolved pause's log entry in the 0.1.1 shape, answered by `responder` (its actor). */
export const answerOf = (
  responder: string,
  key = "child-7:refund-agent:1:call-1",
  askedAt = new Date("2026-01-05T09:00:00.000Z"),
): PauseAnswerRecord => ({
  pauseId: undefined,
  executionId: "child-7",
  step: {
    component: {
      name: "refund-agent",
      kind: ComponentKind.Agent,
      promptHash: undefined,
      schemaHash: undefined,
    },
    nodeId: "refund-agent",
    visitNumber: 1,
    idempotencyKey: key,
    callId: "call-1",
    itemIndex: undefined,
    copyNumber: 1,
    toolLoopIteration: 1,
    validationAttempts: 0,
  },
  target: "refund-tool-approval",
  channel: "refund-approval-channel",
  respondent: PauseRespondent.Delegate,
  actor: { id: responder, orgId: "holding-hq" },
  resolution: PauseResolution.Replied,
  askedAt,
  resolvedAt: new Date("2026-01-05T09:05:00.000Z"),
  decision: { approved: true },
  input: { text: "10 USD" },
  toolCall: { callId: "call-1", tool: "charge", summary: "charge" },
  assignees: ["manager-17", "manager-18"],
  externalRef: "JIRA-17",
  trail: [
    {
      action: "opened",
      at: askedAt,
      target: "refund-tool-approval",
      channel: "refund-approval-channel",
    },
  ],
});
