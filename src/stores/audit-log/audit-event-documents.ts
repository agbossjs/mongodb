import {
  ExecutionAuditEventKind,
  FencedEffectEventOutcome,
  HandOverReason,
  HandOverSite,
  LeaseTakeoverReason,
  OutboundCallEventOutcome,
  OutboundCallStatus,
  type ExecutionAuditEventRecord,
} from "@agboss/core";
import { z } from "zod";

/**
 * A document of `agboss_execution_lease_events` read back: its `record` is the JSON `save`
 * wrote, checked against the four kinds of the audit log (#501; outbound calls, agbossjs/agboss#505; business keys and
 * superseded calls and leases, #508) —
 * documents are never trusted.
 */

const Step = z.strictObject({
  nodeId: z.string(),
  visitNumber: z.number().int(),
  idempotencyKey: z.string(),
});

/** A business key's replay of another step's write (agbossjs/agboss#508): that step. */
const Origin = z.strictObject({
  executionId: z.string(),
  nodeId: z.string(),
  visitNumber: z.number().int(),
});

/** What every row carries. */
const base = {
  occurredAt: z.string(),
  tenantId: z.string(),
  rootExecutionId: z.string(),
  executionId: z.string(),
  scopeKey: z.string(),
  token: z.number().int(),
  holderInstanceId: z.string(),
};

const Takeover = z.strictObject({
  ...base,
  kind: z.literal(ExecutionAuditEventKind.Takeover),
  reason: z.enum(LeaseTakeoverReason),
  previousHolderInstanceId: z.string().optional(),
  previousToken: z.number().int().optional(),
  checkpointId: z.string().optional(),
});

const HandedOver = z.strictObject({
  ...base,
  kind: z.literal(ExecutionAuditEventKind.HandedOver),
  reason: z.enum(HandOverReason),
  site: z.enum(HandOverSite),
  step: Step,
  observedToken: z.number().int().optional(),
});

const FencedEffect = z.strictObject({
  ...base,
  kind: z.literal(ExecutionAuditEventKind.FencedEffect),
  name: z.string(),
  outcome: z.enum(FencedEffectEventOutcome),
  step: Step,
  writtenToken: z.number().int().optional(),
  replayedFrom: Origin.optional(),
  observedToken: z.number().int().optional(),
});

const OutboundCall = z.strictObject({
  ...base,
  kind: z.literal(ExecutionAuditEventKind.OutboundCall),
  name: z.string(),
  target: z.string(),
  operation: z.string(),
  status: z.enum(OutboundCallStatus),
  attempt: z.number().int(),
  outcome: z.enum(OutboundCallEventOutcome),
  step: Step,
  replayedFrom: Origin.optional(),
  supersededBy: z.number().int().optional(),
  closedLease: z
    .strictObject({
      rootExecutionId: z.string(),
      leaseExecutionId: z.string(),
      token: z.number().int(),
    })
    .optional(),
});

const Record = z.discriminatedUnion("kind", [Takeover, HandedOver, FencedEffect, OutboundCall]);

const EventDocument = z.object({ record: z.string() });

/** An outbound call's outcomes a document written before agbossjs/agboss#825 names by their old values. */
const RENAMED_OUTCOMES: Readonly<Partial<Record<string, OutboundCallEventOutcome>>> = {
  superseded: OutboundCallEventOutcome.AttemptSuperseded,
  "lease-superseded": OutboundCallEventOutcome.LeaseClosed,
};

/**
 * A document's record under this version's names (agbossjs/agboss#825, the migration of what is stored, read in
 * place): an outbound call's `superseded` is `attempt-superseded`, its `lease-superseded`
 * `lease-closed` and its `supersededLease` `closedLease`; anything else as it is, checked after.
 */
function currentNamesOf(record: unknown): unknown {
  if (typeof record !== "object" || record === null) return record;
  const { outcome, supersededLease, ...rest } = record as {
    readonly outcome?: unknown;
    readonly supersededLease?: unknown;
  };
  const renamed = typeof outcome === "string" ? (RENAMED_OUTCOMES[outcome] ?? outcome) : outcome;
  const closed = supersededLease === undefined ? {} : { closedLease: supersededLease };
  return { ...rest, ...(outcome === undefined ? {} : { outcome: renamed }), ...closed };
}

/** The record of a document. */
export const auditEventOf = (found: unknown): ExecutionAuditEventRecord =>
  Record.parse(currentNamesOf(JSON.parse(EventDocument.parse(found).record)));
