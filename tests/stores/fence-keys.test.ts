/**
 * agbossjs/agboss#81: the keys of the fence's Mongo statements that no mutant of Stryker drops (it
 * empties a whole literal, never removes one key), each proved by a test that fails without it.
 * A fence check is a real change of the lease document every time, whatever the clock says
 * (`fenceChecks` counts up: a no-op update is not locked); the scope's mark is raised in the
 * transaction and says when; a business key's lock counts and says when.
 */
import {
  FencedEffectSettings,
  StoreClock,
  StoreTimeSource,
  type ExecutionLease,
} from "@agboss/core";
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { hours } from "@agboss/core/units";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Collections,
  MongoExecutionLeaseRepository,
  MongoFencedEffectRepository,
} from "../../src/index.js";
import { treeIdOf } from "../../src/stores/keys.js";
import { HandClock } from "../contracts/lease-races.js";
import { instanceConnection } from "../contracts/mongodb-store.js";
import { TestApplicationContext } from "../support/application-context.js";
import { commandsOf, nameOf } from "../support/command-log.js";
import { emptyAll, testDatabase } from "../support/database.js";

vi.mock("mongodb", async (importOriginal) => {
  const { reportingCommands } = await import("../support/command-log.js");
  return reportingCommands(await importOriginal());
});

const database = testDatabase();
const TENANT = "default";

beforeEach(() => emptyAll(database.url()));

/** One instance's stores on a clock that does not move: every check reads the same time. */
async function instance() {
  const clock = new HandClock();
  const store = new StoreClock(StoreTimeSource.Test, clock);
  const connection = await instanceConnection(database, "instance-1");
  return {
    clock,
    connection,
    leases: new MongoExecutionLeaseRepository(
      connection,
      store,
      new TestApplicationContext({}, "instance-1"),
    ),
    effects: new MongoFencedEffectRepository(connection, store, new FencedEffectSettings()),
  };
}

/** The key of effect `name` under `lease`, of the tree of `root` (a child's key names its root). */
const keyOf = (lease: ExecutionLease, name: string, root = lease.rootExecutionId) =>
  effectKeyForTesting({
    scopeKey: `${TENANT}:${lease.rootExecutionId}`,
    tenantId: TENANT,
    leaseExecutionId: lease.rootExecutionId,
    rootExecutionId: root,
    token: lease.token,
    idempotencyKey: `${lease.rootExecutionId}:charge:${name}`,
    name,
  });

const lease = async (leases: MongoExecutionLeaseRepository, root: string) => {
  const taken = await leases.acquire(TENANT, root, hours(1));
  if (taken === undefined) throw new Error("the take was refused");
  return taken;
};

const stored = <T extends object>(
  connection: Awaited<ReturnType<typeof instanceConnection>>,
  name: string,
) => connection.db.collection<{ _id: string } & T>(name);

describe("agbossjs/agboss#81: the fence check is a real change every time", () => {
  it("counts the lease's checks under a clock that does not move", async () => {
    const { connection, leases, effects } = await instance();
    const held = await lease(leases, "counted");

    await effects.runOnce(keyOf(held, "one"), () => ({ receipt: "1" }));
    await effects.runOnce(keyOf(held, "two"), () => ({ receipt: "2" }));

    expect(
      await stored<{ fenceChecks: number }>(connection, Collections.ExecutionLeases).findOne(
        { _id: treeIdOf(TENANT, "counted") },
        { projection: { fenceChecks: 1 } },
      ),
    ).toMatchObject({ fenceChecks: 2 });
  });

  it("counts the root's checks too, for the key of a child under it", async () => {
    const { connection, leases, effects } = await instance();
    const child = await lease(leases, "child-1");

    await effects.runOnce(keyOf(child, "one", "tree-root"), () => ({ receipt: "1" }));
    await effects.runOnce(keyOf(child, "two", "tree-root"), () => ({ receipt: "2" }));

    expect(
      await stored<{ fenceChecks: number }>(connection, Collections.ExecutionLeases).findOne(
        { _id: treeIdOf(TENANT, "tree-root") },
        { projection: { fenceChecks: 1 } },
      ),
    ).toMatchObject({ fenceChecks: 2 });
  });
});

describe("agbossjs/agboss#81: the scope's mark", () => {
  it("is raised in the effect's transaction, with the time it was raised at", async () => {
    const { clock, connection, leases, effects } = await instance();
    const held = await lease(leases, "marked");
    const log = commandsOf(connection);

    await effects.runOnce(keyOf(held, "one"), () => ({ receipt: "1" }));

    const marks = log.filter(
      (one) => nameOf(one) === `findAndModify ${Collections.FencedEffectMarks}`,
    );
    expect(marks).toHaveLength(1);
    expect(log.every((one) => one.inTransaction)).toBe(true);
    expect(
      await stored(connection, Collections.FencedEffectMarks).findOne({ _id: `${TENANT}:marked` }),
    ).toEqual({ _id: `${TENANT}:marked`, highestToken: held.token, storedAt: clock.now() });
  });
});

describe("agbossjs/agboss#81: a business key's lock", () => {
  it("counts every call that takes it, and says when it was last taken", async () => {
    const { clock, connection, leases, effects } = await instance();
    const held = await lease(leases, "locked");
    const key = (name: string) =>
      effectKeyForTesting(keyOf(held, name), {
        businessKey: "order:42",
        fingerprint: "fingerprint-a",
        origin: { executionId: "locked", nodeId: "charge-action", visitNumber: 1 },
      });

    await effects.runOnce(key("one"), () => ({ receipt: "1" }));
    // the same key again: a replay of the first, which takes the lock first
    await effects.runOnce(key("one"), () => ({ receipt: "2" }));

    expect(
      await stored(connection, Collections.FencedKeyLocks).find().project({ _id: 0 }).toArray(),
    ).toEqual([{ locks: 2, lockedAt: clock.now() }]);
  });
});
