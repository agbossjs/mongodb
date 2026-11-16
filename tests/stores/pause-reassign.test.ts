/**
 * agbossjs/agboss#946 on MongoDB: the re-send scan reads the partial index `reassigned_unsent` in its
 * own order (`askedAt, tenantId, pauseId`); two reassignments of different pauses of one tree at once
 * take different `~r<n>` step keys (the transaction's snapshot and the unique step key conflict, the
 * loser runs again); a replacement leaves the index when it is sent.
 */
import { NO_RECIPIENTS } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { Collections, MongoPausedExecutionRepository } from "../../src/index.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { NINE, pauseOf } from "../support/pauses.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();

beforeEach(() => emptyAll(database.url()));

const storeOn = () =>
  new MongoPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());

const reassign = (store: MongoPausedExecutionRepository, from: string, to: string) =>
  store.reassignByTenantIdAndPauseId(
    "default",
    from,
    { pauseId: to, assignee: "alice" },
    NINE,
    NO_RECIPIENTS,
  );

describe("agbossjs/agboss#946: the reassignment's store", () => {
  it("the re-send scan is an index scan of reassigned_unsent, and a sent replacement leaves it", async () => {
    const store = storeOn();
    await store.findOrCreateByStepKey(pauseOf("p1"));
    await reassign(store, "p1", "p1-r");
    const cutoff = new Date(NINE.getTime() + 60_000);

    const plan = await connectionTo(database.url())
      .db.collection(Collections.Pauses)
      .find({
        status: "pending",
        isSent: false,
        reassignedFrom: { $exists: true },
        askedAt: { $lt: cutoff },
      })
      .sort({ askedAt: 1, tenantId: 1, pauseId: 1 })
      .explain("queryPlanner");

    expect(JSON.stringify(plan)).toContain("reassigned_unsent");
    expect(
      (await store.findPendingUnsentReassignedBefore(cutoff, 10)).map((one) => one.pauseId),
    ).toEqual(["p1-r"]);
    await store.markSentByTenantIdAndPauseId("default", "p1-r", NO_RECIPIENTS);
    expect(await store.findPendingUnsentReassignedBefore(cutoff, 10)).toEqual([]);
  });

  it("two pauses of one tree reassigned at once from two instances take different step keys", async () => {
    const one = storeOn();
    const two = storeOn();
    for (const id of ["a", "b", "c", "d"])
      await one.findOrCreateByStepKey(pauseOf(id, `run-1:s:${id}`));

    const made = await Promise.all([
      reassign(one, "a", "a-r"),
      reassign(two, "b", "b-r"),
      reassign(one, "c", "c-r"),
      reassign(two, "d", "d-r"),
    ]);

    expect(made.every((pause) => pause !== undefined)).toBe(true);
    const keys = made.map((pause) => pause?.stepKey);
    expect(new Set(keys).size).toBe(4);
    expect(keys.sort()).toEqual(["run-1:s:a~r1", "run-1:s:b~r1", "run-1:s:c~r1", "run-1:s:d~r1"]);
  });
});
