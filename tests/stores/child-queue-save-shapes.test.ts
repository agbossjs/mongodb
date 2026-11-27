/**
 * The child queue's save and its isolated-worker list as the client sends them (a fake collection, no server).
 */
import { ChildPlacement, ExecutionRecordStatus } from "@agboss/core";
import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";
import { MongoChildExecutionQueueRepository } from "../../src/index.js";

const dbOf = (collection: object): Db => ({ collection: () => collection }) as never;
const connectionOf = (collection: object) => ({ db: dbOf(collection) }) as never;
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
