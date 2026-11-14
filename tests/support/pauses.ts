import { PauseAnswerer, PauseKind, PauseStatus, type PauseRecord } from "@agboss/core";

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
  channel: "refund-approval-channel",
  answerer: PauseAnswerer.Channel,
  ask: { callId: "call-1", tool: "charge", arguments: { text: "10 USD" }, summary: "charge" },
  status: PauseStatus.Pending,
  isSent: false,
  askedAt: "2026-01-05T09:00:00.000Z",
});

export const NINE = new Date("2026-01-05T09:00:00.000Z");
export const ANSWER = { decision: { approved: true }, answeredBy: "manager-17" };
