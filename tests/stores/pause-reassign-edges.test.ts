/**
 * agbossjs/agboss#1213: the edges of a reassignment and of the retention that follows it — the step
 * keys taken are the tree's own, a refused compare-and-set writes nothing, and one sweep removes a
 * whole chain of reassignments, oldest first.
 */
import { PauseResolution, PauseStatus } from "@agboss/core";
import { NO_RECIPIENTS } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Collections, MongoPausedExecutionRepository } from "../../src/index.js";
import { inStatus, PAUSE_GUARDS, type PauseGuards } from "../../src/stores/paused/pause-guards.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { NINE, pauseOf } from "../support/pauses.js";
import { insertTakenRows } from "../support/pause-rows.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();
const LATER = new Date(NINE.getTime() + 60_000);

beforeEach(() => emptyAll(database.url()));

const storeOn = () =>
  new MongoPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());

const reassign = (store: MongoPausedExecutionRepository, from: string, to: string) =>
  store.reassignByTenantIdAndPauseId(
    "default",
    from,
    { pauseId: to, assignees: ["alice"] },
    NINE,
    NO_RECIPIENTS,
  );

/** A store whose compare-and-set for an open pause matches nothing: the deadline's decision, refused. */
class RefusingGuard extends MongoPausedExecutionRepository {
  protected override get guards(): PauseGuards {
    return { ...PAUSE_GUARDS, open: () => inStatus(PauseStatus.Taken) };
  }
}

describe("agbossjs/agboss#1213: a reassignment's step key", () => {
  it("the keys taken are those of the pause's own tree: another tree's, and another tenant's, do not count", async () => {
    const store = storeOn();
    await store.findOrCreateByStepKey(pauseOf("p"));
    await store.findOrCreateByStepKey({
      ...pauseOf("other-tree", "run-1:p:1~r1"),
      rootExecutionId: "run-2",
    });
    await store.findOrCreateByStepKey({
      ...pauseOf("other-tenant", "run-1:p:1~r1"),
      tenantId: "other",
    });

    expect((await reassign(store, "p", "p-r"))?.stepKey).toBe("run-1:p:1~r1");
    expect((await reassign(store, "p-r", "p-rr"))?.stepKey).toBe("run-1:p:1~r2");
  });
});

describe("agbossjs/agboss#1213: a refused compare-and-set writes nothing", () => {
  it("the pause stays open, no replacement is inserted", async () => {
    const store = new RefusingGuard(connectionTo(database.url()), new VirtualClock());
    await store.findOrCreateByStepKey(pauseOf("p"));

    expect(await reassign(store, "p", "p-r")).toBeUndefined();

    const { db } = connectionTo(database.url());
    expect(await db.collection(Collections.Pauses).distinct("pauseId")).toEqual(["p"]);
    expect((await store.findByTenantIdAndPauseId("default", "p"))?.status).toBe(
      PauseStatus.Pending,
    );
  });
});

describe("agbossjs/agboss#1213: the retention of a chain and of a long list", () => {
  it("a chain is removed one link per sweep, the newest first", async () => {
    const store = storeOn();
    await store.findOrCreateByStepKey(pauseOf("p1"));
    await reassign(store, "p1", "p2");
    await reassign(store, "p2", "p3");
    await store.cancelByTenantIdAndPauseId(
      "default",
      "p3",
      PauseResolution.Cancelled,
      NINE,
      NO_RECIPIENTS,
    );
    const { db } = connectionTo(database.url());
    const left = async (): Promise<string[]> =>
      z
        .array(z.string())
        .parse(await db.collection(Collections.Pauses).distinct("pauseId"))
        .sort();

    await store.deleteByResolvedAtBefore(LATER);
    expect(await left()).toEqual(["p1", "p2"]);
    await store.deleteByResolvedAtBefore(LATER);
    expect(await left()).toEqual(["p1"]);
    await store.deleteByResolvedAtBefore(LATER);
    expect(await left()).toEqual([]);
  });

  it("one sweep goes on past a batch of the retention until nothing is left to remove", async () => {
    const { db } = connectionTo(database.url());
    await insertTakenRows(db, 501, NINE.toISOString());

    await storeOn().deleteByResolvedAtBefore(LATER);

    expect(await db.collection(Collections.Pauses).countDocuments()).toBe(0);
  });
});
