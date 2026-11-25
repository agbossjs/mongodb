import { PauseKind, PauseStatus, type PauseRecord } from "@agboss/core";
import { PauseRespondent } from "@agboss/core/stores";

/** A pending approval pause of `pauseId` at the step `stepKey`, asked at nine on 2026-01-05. */
export const pauseOf = (pauseId: string, stepKey = `run-1:${pauseId}:1`): PauseRecord => ({
  pauseId,
  tenantId: "default",
  threadId: "thread-1",
  rootExecutionId: "run-1",
  executionId: "run-1",
  workflow: "order-workflow",
  stepKey,
  nodeId: "clerk-agent",
  visitNumber: 1,
  itemIndex: undefined,
  copyNumber: 1,
  kind: PauseKind.Approval,
  step: "clerk-agent",
  target: "refund-tool-approval",
  channel: "refund-approval-channel",
  respondent: PauseRespondent.Delegate,
  input: { text: "10 USD" },
  toolCall: { callId: "call-1", tool: "charge", summary: "charge" },
  trail: [
    {
      action: "opened",
      at: "2026-01-05T09:00:00.000Z",
      target: "refund-tool-approval",
      channel: "refund-approval-channel",
    },
  ],
  status: PauseStatus.Pending,
  isSent: false,
  askedAt: "2026-01-05T09:00:00.000Z",
});

export const NINE = new Date("2026-01-05T09:00:00.000Z");
export const ANSWER = { decision: { approved: true }, actor: { id: "manager-17" } };
