import { ExecutionStatus, type CostReport, type PausedExecution } from "@agboss/core";
import { usd } from "@agboss/core/units";
import { pausedRunJsonOf } from "../../src/stores/framework-json.js";

/**
 * A paused run in the 0.1.1 shape (what the core's paused-execution contract stores: no 0.1.0
 * compatibility, so no 0.1.0 literal is read). The JSON a store keeps of it, parsed: what a test
 * reaches into to damage one field.
 */
/** A report of no calls (`CostReport.empty()`; the value is not part of the public entry). */
const NO_COST: CostReport = {
  totalUsd: usd(0),
  calls: 0,
  unknownCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  byCaller: {},
  byCategory: {
    agents: usd(0),
    routing: usd(0),
    guardrails: usd(0),
    review: usd(0),
    tools: usd(0),
    memory: usd(0),
    rag: usd(0),
    files: usd(0),
    pii: usd(0),
    arbiters: usd(0),
    pauses: usd(0),
  },
  byModel: {},
  byProvider: {},
  trace: [],
};

export const pausedRunOf = (threadId = "thread-1", runId = "run-1"): PausedExecution["run"] => ({
  runId,
  threadId,
  tenantId: "default",
  turnId: "turn-1",
  status: ExecutionStatus.Paused,
  start: "order-workflow-start",
  startInput: { text: "charge" },
  budgetUsd: Number.POSITIVE_INFINITY,
  path: ["start", "clerk"],
  cost: NO_COST,
  data: { scope: {}, outdatedValues: [], lastError: null },
  pending: [],
});

/** The stored form of `pausedRunOf()`, as a plain object. */
/** Made on use, never at import: a test file that imports this one must not fail outside a test run. */
export const currentPausedRun = (): Record<string, unknown> =>
  JSON.parse(pausedRunJsonOf(pausedRunOf())) as Record<string, unknown>;
