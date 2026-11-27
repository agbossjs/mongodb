/**
 * The commands some stores send, read as the client gets them (a fake collection, no server): the
 * shapes no contract case tells from a broken one — what a save leaves out or clears, what a sweep
 * projects and sorts by, the filter of a retention, the answer of a forget. Each names the mutant it
 * kills in agbossjs/mongodb's mutation shards (money, queue, mesh-requests, a2a-tasks, a2a-direct).
 */
import { BudgetScope, ChildPlacement, ExecutionRecordStatus } from "@agboss/core";
import { A2ATaskState } from "@agboss/core/stores";
import { usd } from "@agboss/core/units";
import type { Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import {
  MongoChildExecutionQueueRepository,
  MongoCostLedgerRepository,
  MongoMeshRequestRepository,
} from "../../src/index.js";
import { taskDocumentOf, taskOf } from "../../src/stores/a2a-tasks/a2a-task-documents.js";
import { sweptTerminalBefore } from "../../src/stores/a2a-tasks/a2a-task-sweep.js";
import { sweptIn } from "../../src/stores/a2a-direct-messages/a2a-direct-message-sweep.js";

/** A database whose every collection is `collection`. */
const dbOf = (collection: object): Db => ({ collection: () => collection }) as never;
const connectionOf = (collection: object) => ({ db: dbOf(collection) }) as never;

const ACCOUNT = { budget: "b", scope: BudgetScope.Tenant, key: "default" };
const NOW = new Date("2026-01-05T09:00:00.000Z");

/** A collection that records every `updateOne` as `[filter, update, options]`. */
function updating() {
  const calls: unknown[][] = [];
  const collection = {
    updateOne: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ matchedCount: 1, upsertedCount: 0 });
    },
  };
  return { collection, calls };
}

describe("the cost ledger's limit: what a save sets and clears, what a read answers", () => {
  const saved = async (limit: { maxSpend?: ReturnType<typeof usd>; maxTokens?: number }) => {
    const { collection, calls } = updating();
    await new MongoCostLedgerRepository(connectionOf(collection)).saveLimit(ACCOUNT, limit);
    return calls[0]?.[1];
  };

  it("both limits are set, nothing is cleared", async () => {
    expect(await saved({ maxSpend: usd(5), maxTokens: 100 })).toStrictEqual({
      $set: { maxSpendUsd: 5, maxTokens: 100 },
      $unset: {},
    });
  });

  it("a USD-only limit sets the spend and clears the tokens, never one as the other", async () => {
    expect(await saved({ maxSpend: usd(5) })).toStrictEqual({
      $set: { maxSpendUsd: 5 },
      $unset: { maxTokens: "" },
    });
  });

  it("a token-only limit sets the tokens and clears the spend", async () => {
    expect(await saved({ maxTokens: 100 })).toStrictEqual({
      $set: { maxTokens: 100 },
      $unset: { maxSpendUsd: "" },
    });
  });

  it("no limit at all sets nothing and clears both", async () => {
    expect(await saved({})).toStrictEqual({ $unset: { maxSpendUsd: "", maxTokens: "" } });
  });

  it("reads back only the limits the document holds", async () => {
    const found = (document: object) =>
      new MongoCostLedgerRepository(
        connectionOf({ findOne: () => Promise.resolve({ _id: "x", ...document }) }),
      ).findLimitByAccount(ACCOUNT);

    expect(await found({ maxSpendUsd: 5, maxTokens: 100 })).toStrictEqual({
      maxSpend: 5,
      maxTokens: 100,
    });
    expect(await found({ maxSpendUsd: 5 })).toStrictEqual({ maxSpend: 5 });
    expect(await found({ maxTokens: 100 })).toStrictEqual({ maxTokens: 100 });
  });
});

describe("the child queue's save and its isolated-worker list", () => {
  const child = {
    ...{ tenantId: "default", executionId: "c1", rootExecutionId: "r1", parentExecutionId: "r1" },
    ...{ rootWorkflow: "w", workflow: "w", depth: 1, run: "{}", queuedAt: NOW },
  };
  const queue = (collection: object) =>
    new MongoChildExecutionQueueRepository(
      connectionOf(collection),
      undefined as never,
      undefined as never,
      undefined as never,
    );
  const saveOf = async (extra: object) => {
    const { collection, calls } = updating();
    await queue(collection).saveIfAbsent({ ...child, ...extra } as never);
    return calls[0]?.[1] as { $set: Record<string, unknown>; $unset: Record<string, unknown> };
  };

  it("a child with no placement and no excluded instance clears a stale one of an earlier queueing", async () => {
    const update = await saveOf({});

    expect(update.$unset).toMatchObject({ placement: "", excludeInstanceId: "" });
    expect(Object.keys(update.$set)).not.toContain("placement");
    expect(Object.keys(update.$set)).not.toContain("excludeInstanceId");
  });

  it("a child that names its placement sets it and clears only what it leaves out", async () => {
    const update = await saveOf({ placement: ChildPlacement.IsolatedWorker });

    expect(update.$set).toMatchObject({ placement: ChildPlacement.IsolatedWorker });
    expect(Object.keys(update.$set)).not.toContain("excludeInstanceId");
    expect(Object.keys(update.$unset)).not.toContain("placement");
    expect(update.$unset).toMatchObject({ excludeInstanceId: "" });
  });

  it("a child that names the instance to leave out sets it and clears only the placement", async () => {
    const update = await saveOf({ excludeInstanceId: "instance-2" });

    expect(update.$set).toMatchObject({ excludeInstanceId: "instance-2" });
    expect(Object.keys(update.$set)).not.toContain("placement");
    expect(update.$unset).toMatchObject({ placement: "" });
    expect(Object.keys(update.$unset)).not.toContain("excludeInstanceId");
  });

  it("the queued isolated-worker children are found, the deepest first, then the longest waiting, up to the limit", async () => {
    const sorts: unknown[] = [];
    const filters: unknown[] = [];
    const cursor = {
      sort: (sort: unknown) => {
        sorts.push(sort);
        return cursor;
      },
      limit: (limit: number) => {
        sorts.push(limit);
        return cursor;
      },
      toArray: () => Promise.resolve([]),
    };
    const collection = {
      find: (filter: unknown) => {
        filters.push(filter);
        return cursor;
      },
    };

    await queue(collection).findQueuedIsolatedWorkerChildren(7);

    expect(filters).toStrictEqual([
      { status: ExecutionRecordStatus.Queued, placement: ChildPlacement.IsolatedWorker },
    ]);
    expect(sorts).toStrictEqual([{ depth: -1, queuedAt: 1 }, 7]);
  });
});

describe("the mesh request store's forget and retention", () => {
  const meshOn = (collection: object) => new MongoMeshRequestRepository(connectionOf(collection));
  const KEY = { tenantId: "acme", peer: "p", idempotencyKey: "k" };

  it("a forget answers whether the attempt's request was removed", async () => {
    const removing = (deletedCount: number) =>
      meshOn({ deleteOne: () => Promise.resolve({ deletedCount }) });

    expect(await removing(1).deleteByKey(KEY, "a-1")).toBe(true);
    expect(await removing(0).deleteByKey(KEY, "a-1")).toBe(false);
  });

  it("the retention removes what has expired and is answered or lapsed, and tells how many went", async () => {
    const filters: unknown[] = [];
    const store = meshOn({
      deleteMany: (filter: unknown) => {
        filters.push(filter);
        return Promise.resolve({ deletedCount: 3 });
      },
    });

    expect(await store.deleteExpired(NOW)).toBe(3);

    expect(filters).toStrictEqual([
      {
        expiresAt: { $lte: NOW },
        $or: [{ response: { $exists: true } }, { lockedUntil: { $lte: NOW } }],
      },
    ]);
  });
});

describe("the A2A stores' reads and sweeps", () => {
  it("a task's status reads its cancel time back as the Date it was written from", () => {
    const document = taskDocumentOf({
      ...{ endpoint: "e", tenantId: "default", taskId: "t-1", ownerId: "alice" },
      ...{ contextId: "c", skill: "s", version: 1, acceptedAt: NOW, statusAt: NOW },
      status: { state: A2ATaskState.Submitted, pendingPauses: [] },
    });
    const withCancel = {
      ...document,
      status: JSON.stringify({
        state: A2ATaskState.Submitted,
        pendingPauses: [],
        cancelRequestedAt: "2026-01-05T09:30:00.000Z",
      }),
    };

    const { status } = taskOf(withCancel);

    expect(status).toMatchObject({ cancelRequestedAt: new Date("2026-01-05T09:30:00.000Z") });
  });

  it("the task sweep reads only the keys of a batch, at most the batch's size", async () => {
    const calls: unknown[][] = [];
    const collection = {
      find: (...args: unknown[]) => {
        calls.push(args);
        return { toArray: () => Promise.resolve([]) };
      },
    };

    expect(await sweptTerminalBefore(dbOf(collection), "orders", NOW, 25)).toBe(0);

    expect(calls[0]?.[1]).toStrictEqual({ projection: { tenantId: 1, taskId: 1 }, limit: 25 });
  });

  it("the direct-message sweep reads every due message through its schema: a corrupt one fails the sweep, never vanishes unread", async () => {
    const cursor = { toArray: () => Promise.resolve([{ _id: "damaged", state: 7 }]) };
    const db = dbOf({ find: () => cursor, deleteMany: vi.fn() });

    await expect(sweptIn(db, undefined as never, new Map([["orders", NOW]]), 10)).rejects.toThrow();
  });
});
