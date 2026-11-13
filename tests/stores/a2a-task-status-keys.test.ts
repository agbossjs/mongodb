import { A2ATaskState, PauseKind, type NewA2ATask } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { MongoA2ATaskRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#960: one rule at every level of a status: a key this version does not know
 * round-trips, in a pending pause too; a known field stays validated.
 */
const database = testDatabase();
const NINE = new Date("2026-01-05T09:00:00.000Z");

describe("agbossjs/agboss#960: an unknown key inside a pending pause (MongoDB)", () => {
  it("survives a round trip, beside the keys the pause knows", async () => {
    const tasks = new MongoA2ATaskRepository(connectionTo(database.url()));
    const pause = { pauseId: "p-1", kind: PauseKind.Approval, ask: { q: 1 }, futureKey: "kept?" };
    const status = {
      state: A2ATaskState.InputRequired,
      pendingPauses: [pause],
      futureTop: 1,
    };
    const task: NewA2ATask = {
      tenantId: "default",
      taskId: "t-p",
      ownerId: "alice",
      contextId: "ctx-1",
      skill: "s",
      status,
      acceptedAt: NINE,
      messageId: "m-p",
      requestHash: "h-1",
    };

    await tasks.saveIfAbsent(task);

    expect((await tasks.findById(task))?.status).toEqual(status);
  });
});
