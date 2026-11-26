/**
 * agbossjs/agboss#81: the stores' indexes as the migration makes them, written out here once more
 * and compared whole: each collection's secondary indexes by name, in key order, with their
 * direction, uniqueness and partial filter. An index of another key, another direction, not unique
 * or not partial is a different plan or a missing guarantee (a unique `by_step`, `by_seq` is a
 * unique key, never a check in the code), and no other test tells it: a dropped field of an
 * index changes no result, only what the server can promise. A change of the schema changes this
 * table with it.
 */
import { describe, expect, it } from "vitest";
import { Collections } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();

type Key = readonly (readonly [string, 1 | -1])[];
interface Expected {
  readonly name: string;
  readonly key: Key;
  readonly unique?: true;
  readonly partial?: object;
}

const up = (...fields: string[]): Key => fields.map((field) => [field, 1]);

const EXPECTED: Readonly<Record<string, readonly Expected[]>> = {
  [Collections.FencedEffectMarks]: [{ name: "by_stored_at", key: up("storedAt") }],
  [Collections.CostEntries]: [{ name: "by_made_at", key: up("madeAt") }],
  [Collections.FencedEffectResults]: [{ name: "by_stored_at", key: up("storedAt") }],
  [Collections.OutboundCalls]: [
    { name: "by_tree", key: up("tenantId", "rootExecutionId", "seq") },
    { name: "by_status", key: up("tenantId", "status", "seq") },
    { name: "by_ended_at", key: up("endedAt") },
  ],
  [Collections.ExecutionAuditLog]: [
    { name: "by_tree", key: up("tenantId", "rootExecutionId", "occurredAt", "_id") },
    { name: "by_occurred_at", key: up("occurredAt") },
  ],
  [Collections.ExecutionRecords]: [
    { name: "by_seq", key: up("seq"), unique: true },
    { name: "by_thread", key: up("tenantId", "threadId", "seq") },
    { name: "by_run", key: up("tenantId", "runId", "seq") },
    { name: "by_status", key: up("status", "seq") },
    { name: "by_version", key: up("bundle", "promptVersion", "seq") },
    { name: "by_workflow", key: up("bundle", "seq") },
  ],
  [Collections.ExecutionScores]: [{ name: "by_record", key: up("recordId") }],
  [Collections.ExecutionSummaries]: [
    { name: "by_thread", key: up("tenantId", "threadId", "compaction", "toSeq") },
  ],
  [Collections.PauseAnswers]: [
    { name: "by_tree", key: up("tenantId", "rootExecutionId", "askedAt", "seq") },
  ],
  [Collections.ExecutionTreeKeys]: [{ name: "by_tree", key: up("tenantId", "rootExecutionId") }],
  [Collections.Pauses]: [
    { name: "by_step", key: up("tenantId", "rootExecutionId", "stepKey"), unique: true },
    { name: "by_tree", key: up("tenantId", "rootExecutionId", "seq") },
    { name: "by_resolution", key: up("status", "resolvedAt") },
    {
      name: "pending_by_expiry",
      key: up("status", "expiresAt"),
      partial: { status: "pending", expiresAt: { $type: "date" } },
    },
    {
      name: "pending_by_remind",
      key: up("status", "remindAt"),
      partial: { status: "pending", remindAt: { $type: "date" } },
    },
    { name: "by_tenant", key: up("tenantId", "status", "target", "seq") },
    {
      name: "reassigned_unsent",
      key: up("askedAt", "tenantId", "pauseId"),
      partial: { status: "pending", isSent: false, reassignedFrom: { $exists: true } },
    },
    {
      name: "open",
      key: up("status", "seq"),
      partial: { status: { $in: ["pending", "resolved"] } },
    },
    { name: "by_status", key: up("status", "seq") },
    { name: "by_channel", key: up("channel", "status", "seq") },
    { name: "by_assignee", key: up("assignees", "seq") },
    {
      name: "by_external_ref",
      key: up("externalRef", "seq"),
      partial: { externalRef: { $exists: true } },
    },
  ],
  [Collections.PauseNotices]: [
    { name: "due", key: up("isDead", "nextAttemptAt") },
    { name: "stale", key: up("isDead", "headWrittenAt") },
    { name: "by_pause", key: up("pauseId", "tenantId") },
  ],
  [Collections.ChildExecutionQueue]: [
    {
      name: "by_claim",
      key: [
        ["status", 1],
        ["depth", -1],
        ["queuedAt", 1],
      ],
    },
    { name: "by_tree", key: up("tenantId", "rootExecutionId") },
  ],
  [Collections.ExecutionHistory]: [
    { name: "by_execution", key: up("executionId", "startedAt") },
    { name: "by_thread", key: up("tenantId", "threadId", "startedAt") },
    { name: "by_tenant_start", key: up("tenantId", "startedAt", "executionId") },
    { name: "by_start", key: up("startedAt", "executionId") },
    { name: "by_ended_at", key: up("endedAt") },
  ],
  [Collections.MeshRequests]: [{ name: "by_created_at", key: up("createdAt") }],
  [Collections.A2ATasks]: [
    {
      name: "by_owner",
      key: [
        ["tenantId", 1],
        ["ownerId", 1],
        ["statusAt", -1],
        ["taskId", -1],
      ],
    },
    { name: "by_finished", key: up("state", "statusAt") },
  ],
  [Collections.A2AMessages]: [
    { name: "by_task", key: up("tenantId", "taskId") },
    { name: "by_claim", key: up("taskId", "savedAt") },
  ],
  [Collections.A2ADirectMessages]: [
    { name: "by_in_flight", key: up("state", "expiresAt") },
    { name: "by_created_at", key: up("createdAt") },
  ],
  [Collections.Checkpoints]: [
    {
      name: "by_thread",
      key: [
        ["threadId", 1],
        ["namespace", 1],
        ["checkpointId", -1],
      ],
    },
    { name: "by_checkpoint", key: [["checkpointId", -1]] },
    {
      name: "latest_by_step",
      key: [
        ["threadId", 1],
        ["namespace", 1],
        ["step", -1],
        ["checkpointId", -1],
      ],
    },
  ],
  [Collections.CheckpointWrites]: [
    { name: "by_checkpoint", key: up("threadId", "namespace", "checkpointId", "seq", "position") },
  ],
};

/** What the server lists of one collection's indexes but its `_id` one, by name. */
async function indexesOf(collection: string): Promise<Expected[]> {
  const listed = await connectionTo(database.url())
    .db.collection(collection)
    .listIndexes()
    .toArray();
  return listed
    .filter((one) => one.name !== "_id_")
    .map((one) => ({
      name: String(one.name),
      key: Object.entries(one.key as Record<string, 1 | -1>),
      ...(one.unique === true ? { unique: true as const } : {}),
      ...(one.partialFilterExpression === undefined
        ? {}
        : { partial: one.partialFilterExpression as object }),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

describe("agbossjs/agboss#81: the indexes of the stores' collections", () => {
  it.each(Object.entries(EXPECTED))("%s", async (collection, expected) => {
    expect(await indexesOf(collection)).toEqual(
      [...expected].sort((left, right) => left.name.localeCompare(right.name)),
    );
  });

  it("no collection has an index this table does not name", async () => {
    const withIndexes = Object.values(Collections).filter(
      (name) => !(name in EXPECTED) && name !== Collections.SchemaVersion,
    );
    for (const collection of withIndexes) expect(await indexesOf(collection)).toEqual([]);
  });
});
