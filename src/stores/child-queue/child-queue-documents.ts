import { ChildPlacement, ExecutionRecordStatus, type QueuedChildExecution } from "@agboss/core";
import { z } from "zod";

/** The documents of the child queue (#333) and what its aggregation and its reads give. */

/** One queued child: the contract's fields, `_id` its tenant and execution. */
export interface QueuedDocument extends Omit<
  QueuedChildExecution,
  "instanceId" | "claimedAt" | "endedAt" | "failure" | "placement" | "excludeInstanceId"
> {
  _id: string;
  placement?: ChildPlacement;
  excludeInstanceId?: string;
  instanceId?: string;
  claimedAt?: Date;
  endedAt?: Date;
  failure?: string;
}

const Stored = z.object({
  tenantId: z.string(),
  executionId: z.string(),
  rootExecutionId: z.string(),
  parentExecutionId: z.string(),
  rootWorkflow: z.string(),
  workflow: z.string(),
  depth: z.number(),
  status: z.enum(ExecutionRecordStatus),
  run: z.string(),
  queuedAt: z.date(),
  instanceId: z.string().optional(),
  claimedAt: z.date().optional(),
  endedAt: z.date().optional(),
  failure: z.string().optional(),
  placement: z.enum(ChildPlacement).optional(),
  excludeInstanceId: z.string().optional(),
});

/** The queue's depth, as one `$group` gives it (none when no row is queued or running). */
export const Depth = z.object({
  queued: z.number(),
  running: z.number(),
  oldest: z.date().nullable(),
});

/** The value of a field named in `$unset`: the server ignores it, whatever it is. */
// Stryker disable next-line StringLiteral: equivalent, `$unset` ignores the value of each field it names
export const UNSET = "";

const isStatus = (status: ExecutionRecordStatus) => ({ $eq: ["$status", status] });

/**
 * The queue's depth (agbossjs/agboss#485): one aggregation over the `status` prefix of the claims
 * index — the queued and running documents only, grouped once.
 */
export const DEPTH = [
  { $match: { status: { $in: [ExecutionRecordStatus.Queued, ExecutionRecordStatus.Running] } } },
  {
    $group: {
      _id: null,
      queued: { $sum: { $cond: [isStatus(ExecutionRecordStatus.Queued), 1, 0] } },
      running: { $sum: { $cond: [isStatus(ExecutionRecordStatus.Running), 1, 0] } },
      oldest: { $min: { $cond: [isStatus(ExecutionRecordStatus.Queued), "$queuedAt", null] } },
    },
  },
];

/** A document as the contract gives it back. */
export const childOf = (found: unknown): QueuedChildExecution => {
  const { instanceId, claimedAt, endedAt, failure, placement, excludeInstanceId, ...child } =
    Stored.parse(found);
  return { ...child, instanceId, claimedAt, endedAt, failure, placement, excludeInstanceId };
};
