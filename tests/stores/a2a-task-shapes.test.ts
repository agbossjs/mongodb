/**
 * The A2A task store's status read and sweep as the client sends them (a fake collection, no server).
 */
import { A2ATaskState } from "@agboss/core/stores";
import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";
import { taskDocumentOf, taskOf } from "../../src/stores/a2a-tasks/a2a-task-documents.js";
import { sweptTerminalBefore } from "../../src/stores/a2a-tasks/a2a-task-sweep.js";

const dbOf = (collection: object): Db => ({ collection: () => collection }) as never;
const NOW = new Date("2026-01-05T09:00:00.000Z");

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
});
