/**
 * agbossjs/agboss#1321e on MongoDB: the lease document as the mirror of a cluster's lease (D6: the
 * database's document is the authority) — one atomic upsert that only rises, refuses a stale lease
 * or a retired document, never touches the marks nor the fence, and is live "for good" so every
 * check of a lease (`expiresAt > now`) passes for it.
 */
import { InterruptMode, StoreClock, StoreTimeSource, type ExecutionLease } from "@agboss/core";
import {
  CLUSTER_LEASE_EXPIRY,
  ClusterLeaseSyncOutcome,
  MirroredLeaseState,
} from "@agboss/core/stores";
import { seconds } from "@agboss/core/units";
import { beforeEach, describe, expect, it } from "vitest";
import { Collections, MongoExecutionLeaseRepository } from "../../src/index.js";
import { treeIdOf } from "../../src/stores/keys.js";
import type { LeaseDocument } from "../../src/stores/lease-documents.js";
import { HandClock } from "../contracts/lease-races.js";
import { instanceConnection } from "../contracts/mongodb-store.js";
import { TestApplicationContext } from "../support/application-context.js";
import { emptyAll, testDatabase } from "../support/database.js";

const database = testDatabase();
const TENANT = "default";

beforeEach(() => emptyAll(database.url()));

async function store(instanceId = "instance-1") {
  const clock = new HandClock();
  const connection = await instanceConnection(database, instanceId);
  return {
    connection,
    leases: new MongoExecutionLeaseRepository(
      connection,
      new StoreClock(StoreTimeSource.Test, clock),
      new TestApplicationContext(instanceId),
    ),
  };
}

const lease = (root: string, token: number, holder = "pod-a"): ExecutionLease => ({
  tenantId: TENANT,
  rootExecutionId: root,
  holderInstanceId: holder,
  token,
  expiresAt: CLUSTER_LEASE_EXPIRY,
  remaining: seconds(30),
});

const tree = (root: string) => ({ tenantId: TENANT, rootExecutionId: root });

describe("syncClusterLease", () => {
  it("writes a lease no document has: held at its token, live for good", async () => {
    const { connection, leases } = await store();

    expect(await leases.syncClusterLease(lease("fresh", 3))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Synced,
    });

    expect(await leases.mirroredLeaseOf(tree("fresh"))).toEqual({
      token: 3,
      holderInstanceId: "pod-a",
      state: MirroredLeaseState.Held,
    });
    expect(
      await connection.db
        .collection<LeaseDocument>(Collections.ExecutionLeases)
        .findOne({ _id: treeIdOf(TENANT, "fresh") }),
    ).toMatchObject({ expiresAt: CLUSTER_LEASE_EXPIRY, released: false, finished: false });
  });

  it("rises: a higher token replaces the lease; the same lease again is a no-op that still answers synced", async () => {
    const { leases } = await store();
    await leases.syncClusterLease(lease("rise", 1));

    expect(await leases.syncClusterLease(lease("rise", 1))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Synced,
    });
    expect(await leases.syncClusterLease(lease("rise", 2, "pod-b"))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Synced,
    });

    expect(await leases.mirroredLeaseOf(tree("rise"))).toMatchObject({
      token: 2,
      holderInstanceId: "pod-b",
    });
  });

  it("a lower token, another holder at the token, and a released document at the token are behind", async () => {
    const { leases } = await store();
    await leases.syncClusterLease(lease("behind", 5));

    expect(await leases.syncClusterLease(lease("behind", 4))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Behind,
      rowToken: 5,
    });
    expect(await leases.syncClusterLease(lease("behind", 5, "pod-b"))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Behind,
      rowToken: 5,
    });
    await leases.endClusterLease(lease("behind", 5), { isRetired: false });
    expect(await leases.syncClusterLease(lease("behind", 5))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Behind,
      rowToken: 5,
    });
    expect(await leases.mirroredLeaseOf(tree("behind"))).toMatchObject({
      state: MirroredLeaseState.Released,
    });
  });

  it("a retired document is never written over, at any token", async () => {
    const { leases } = await store();
    await leases.syncClusterLease(lease("retired", 2));
    await leases.endClusterLease(lease("retired", 2), { isRetired: true });

    expect(await leases.syncClusterLease(lease("retired", 9))).toEqual({
      outcome: ClusterLeaseSyncOutcome.Retired,
    });
    expect(await leases.mirroredLeaseOf(tree("retired"))).toMatchObject({
      token: 2,
      state: MirroredLeaseState.Retired,
    });
  });

  it("an end by another holder or at another token changes nothing", async () => {
    const { leases } = await store();
    await leases.syncClusterLease(lease("kept", 2));

    await leases.endClusterLease(lease("kept", 1), { isRetired: false });
    await leases.endClusterLease(lease("kept", 2, "pod-b"), { isRetired: true });

    expect(await leases.mirroredLeaseOf(tree("kept"))).toMatchObject({
      state: MirroredLeaseState.Held,
    });
  });

  it("keeps the marks and the fence of the document it is written into", async () => {
    const { leases } = await store();
    await leases.requestCancel(tree("marked"));
    await leases.requestStop(tree("marked"), InterruptMode.Immediate);
    await leases.requestPause(tree("marked"), { mode: InterruptMode.Immediate, reason: "hold" });

    await leases.syncClusterLease(lease("marked", 4));

    expect(await leases.markedOf(tree("marked"))).toEqual({
      isCancelRequested: true,
      stop: { mode: InterruptMode.Immediate },
      pause: { mode: InterruptMode.Immediate, reason: "hold" },
      fencedThroughToken: 0,
    });
  });

  it("of several syncs racing, the highest token wins whatever the order", async () => {
    const { leases } = await store();
    const tokens = [3, 1, 5, 2, 4];

    await Promise.all(tokens.map((token) => leases.syncClusterLease(lease("race", token))));

    expect((await leases.mirroredLeaseOf(tree("race")))?.token).toBe(5);
  });

  it("mirroredLeaseOf of a tree with no document is none", async () => {
    const { leases } = await store();

    expect(await leases.mirroredLeaseOf(tree("none"))).toBeUndefined();
  });
});
