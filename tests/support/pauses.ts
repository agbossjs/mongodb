import {
  PauseKind,
  PauseStatus,
  type PausedExecutionRepository,
  type PauseRecord,
} from "@agboss/core";
import { PauseRespondent, seenOf, type PauseSeen } from "@agboss/core/stores";
import type { PauseTrailEntry } from "@agboss/core";

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
      at: new Date("2026-01-05T09:00:00.000Z"),
      target: "refund-tool-approval",
      channel: "refund-approval-channel",
    },
  ],
  status: PauseStatus.Pending,
  isSent: false,
  askedAt: new Date("2026-01-05T09:00:00.000Z"),
  firstAskedAt: new Date("2026-01-05T09:00:00.000Z"),
  escalationLimits: {},
});

export const NINE = new Date("2026-01-05T09:00:00.000Z");
export const ANSWER = { decision: { approved: true }, actor: { id: "manager-17" } };

/** What a change is planned against: the pause `pauseId` as the store holds it now (as the app reads it before a permit). */
export async function seenNow(
  store: Pick<PausedExecutionRepository, "findByTenantIdAndPauseId">,
  pauseId: string,
  tenantId = "default",
): Promise<PauseSeen> {
  const found = await store.findByTenantIdAndPauseId(tenantId, pauseId);
  if (found === undefined) throw new Error(`no pause ${pauseId} to see`);
  return seenOf(found);
}

/** The change with the `seen` of the pause as it is now. */
export async function withSeenNow<C extends object>(
  store: Pick<PausedExecutionRepository, "findByTenantIdAndPauseId">,
  pauseId: string,
  change: C,
): Promise<C & { readonly seen: PauseSeen }> {
  return { ...change, seen: await seenNow(store, pauseId) };
}

/** The `opened` entry every pause's chain of custody starts with. */
export function openedEntryOf(pause: PauseRecord): PauseTrailEntry {
  const [opened] = pause.trail;
  if (opened === undefined) throw new Error(`pause ${pause.pauseId} has no opened entry`);
  return opened;
}
