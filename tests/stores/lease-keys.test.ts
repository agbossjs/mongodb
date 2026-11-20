/**
 * agbossjs/agboss#81: the keys of the lease store's Mongo statements that no mutant of Stryker drops
 * (it empties a whole literal, never removes one key), each proved by a test that fails without
 * it. A 0.1.0 lease document (`leaseEpoch`) is written with `token` and without its old names by
 * each of the commands that write it, a renewal and a release among them; the claim of an
 * execution id stores the tenant that made it.
 */
import { StoreClock, StoreTimeSource, type ExecutionLease } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { beforeEach, describe, expect, it } from "vitest";
import { Collections, MongoExecutionLeaseRepository } from "../../src/index.js";
import { HandClock } from "../contracts/lease-races.js";
import { instanceConnection } from "../contracts/mongodb-store.js";
import { treeIdOf } from "../../src/stores/keys.js";
import { TestApplicationContext } from "../support/application-context.js";
import { emptyAll, testDatabase } from "../support/database.js";

const database = testDatabase();
const LEASE = seconds(30);

beforeEach(() => emptyAll(database.url()));

const leasesOn = async (clock: StoreClock, instanceId = "instance-1") =>
  new MongoExecutionLeaseRepository(
    await instanceConnection(database, instanceId),
    clock,
    new TestApplicationContext({}, instanceId),
  );

/** The stored lease fields of `root`'s document: the token's names, and the flags the writes set. */
async function storedOf(root: string): Promise<unknown> {
  const connection = await instanceConnection(database, "instance-1");
  return connection.db.collection<{ _id: string }>(Collections.ExecutionLeases).findOne(
    { _id: treeIdOf("default", root) },
    {
      projection: {
        ...{ _id: 0, token: 1, leaseEpoch: 1, previousEpoch: 1 },
        ...{ released: 1, finished: 1, yielded: 1, previousHolder: 1, previousToken: 1 },
      },
    },
  );
}

/** A lease document of instance-1 on `root` at `epoch`, as 0.1.0 wrote it (no `token`). */
async function oldDocument(root: string, epoch: number, expiresAt: Date): Promise<void> {
  const connection = await instanceConnection(database, "instance-1");
  await connection.db
    .collection<{ _id: string } & Record<string, unknown>>(Collections.ExecutionLeases)
    .insertOne({
      _id: treeIdOf("default", root),
      ...{ tenantId: "default", rootExecutionId: root, holderInstanceId: "instance-1" },
      leaseEpoch: epoch,
      expiresAt,
      released: false,
      yielded: false,
      superseded: false,
      finished: false,
      previousHolder: null,
      previousEpoch: null,
    });
}

const heldAt = (root: string, token: number, expiresAt: Date): ExecutionLease => ({
  ...{ tenantId: "default", rootExecutionId: root, holderInstanceId: "instance-1" },
  ...{ token, expiresAt, remaining: LEASE },
});

describe("agbossjs/agboss#81: every write of a 0.1.0 lease document stores token and drops the old names", () => {
  it("a renewal", async () => {
    const clock = new HandClock();
    const expiresAt = new Date(clock.now().getTime() + LEASE);
    await oldDocument("old-renew", 7, expiresAt);

    expect(await (await leasesOn(clock)).renew(heldAt("old-renew", 7, expiresAt), LEASE)).toBe(
      LEASE,
    );

    expect(await storedOf("old-renew")).toEqual({
      ...{ token: 7, released: false, finished: false, yielded: false },
      ...{ previousHolder: null },
    });
  });

  it("a release", async () => {
    const clock = new HandClock();
    const expiresAt = new Date(clock.now().getTime() + LEASE);
    await oldDocument("old-release", 9, expiresAt);

    await (await leasesOn(clock)).release(heldAt("old-release", 9, expiresAt));

    expect(await storedOf("old-release")).toEqual({
      ...{ token: 9, released: true, finished: false, yielded: false },
      ...{ previousHolder: null },
    });
  });

  it("a retirement", async () => {
    const clock = new HandClock();
    const expiresAt = new Date(clock.now().getTime() + LEASE);
    await oldDocument("old-retire", 5, expiresAt);

    await (await leasesOn(clock)).retire(heldAt("old-retire", 5, expiresAt));

    expect(await storedOf("old-retire")).toEqual({
      ...{ token: 5, released: true, finished: true, yielded: false },
      ...{ previousHolder: null },
    });
  });

  it("a yield", async () => {
    const clock = new HandClock();
    const expiresAt = new Date(clock.now().getTime() + LEASE);
    await oldDocument("old-yield", 3, expiresAt);

    await (await leasesOn(clock)).yield(heldAt("old-yield", 3, expiresAt));

    expect(await storedOf("old-yield")).toEqual({
      ...{ token: 3, released: false, finished: false, yielded: true },
      ...{ previousHolder: null },
    });
  });

  it("a reclaim, at the next token", async () => {
    const clock = new HandClock();
    const expiresAt = new Date(clock.now().getTime() + LEASE);
    await oldDocument("old-reclaim", 4, expiresAt);

    expect(
      await (await leasesOn(clock)).reclaim(heldAt("old-reclaim", 4, expiresAt), LEASE),
    ).toMatchObject({ token: 5 });

    expect(await storedOf("old-reclaim")).toEqual({
      ...{ token: 5, released: false, finished: false, yielded: false },
      ...{ previousHolder: null, previousToken: null },
    });
  });

  it("a reclaim, which also forgets the takeover the lease was made by", async () => {
    const clock = new HandClock();
    const first = await leasesOn(clock);
    const second = await leasesOn(clock, "instance-2");
    const taken = await first.acquire("default", "reclaimed", LEASE);
    if (taken === undefined) throw new Error("the tree was free");
    await clock.advance(LEASE);
    const takenOver = await second.acquire("default", "reclaimed", LEASE);
    if (takenOver === undefined) throw new Error("the lease had expired");
    expect(await storedOf("reclaimed")).toMatchObject({
      ...{ token: 2, yielded: false },
      ...{ previousHolder: "instance-1", previousToken: 1 },
    });
    await second.yield(takenOver);
    expect(await storedOf("reclaimed")).toMatchObject({ token: 2, yielded: true });

    expect(await second.reclaim(takenOver, LEASE)).toMatchObject({ token: 3 });

    expect(await storedOf("reclaimed")).toEqual({
      ...{ token: 3, released: false, finished: false, yielded: false },
      ...{ previousHolder: null, previousToken: null },
    });
  });

  it("a retirement of a lease that was yielded clears the yield", async () => {
    const clock = new HandClock();
    const leases = await leasesOn(clock);
    const taken = await leases.acquire("default", "retired", LEASE);
    if (taken === undefined) throw new Error("the tree was free");
    await leases.yield(taken);
    expect(await storedOf("retired")).toMatchObject({ yielded: true });

    await leases.retire(taken);

    expect(await storedOf("retired")).toMatchObject({
      ...{ token: 1, released: true, finished: true, yielded: false },
    });
  });
});

/** A lease document of `holder` on `root` as written by hand: `fields` over what a released one has. */
async function rawDocument(root: string, fields: Record<string, unknown>): Promise<void> {
  const connection = await instanceConnection(database, "instance-1");
  await connection.db
    .collection<{ _id: string } & Record<string, unknown>>(Collections.ExecutionLeases)
    .insertOne({
      _id: treeIdOf("default", root),
      ...{ tenantId: "default", rootExecutionId: root, holderInstanceId: "instance-1" },
      ...{ expiresAt: new Date(0), released: true, yielded: false, superseded: false },
      ...{ finished: false, previousHolder: null, previousToken: null },
      ...fields,
    });
}

describe("agbossjs/agboss#81: a take", () => {
  it("writes the whole document of a new tree: its tenant, its root, the holder, the flags", async () => {
    const clock = new HandClock();
    const leases = await leasesOn(clock, "instance-2");

    await leases.acquire("acme", "whole", LEASE);

    const connection = await instanceConnection(database, "instance-1");
    expect(
      await connection.db
        .collection<{ _id: string }>(Collections.ExecutionLeases)
        .findOne({ _id: treeIdOf("acme", "whole") }, { projection: { _id: 0 } }),
    ).toEqual({
      ...{ tenantId: "acme", rootExecutionId: "whole", holderInstanceId: "instance-2" },
      ...{ token: 1, expiresAt: new Date(clock.now().getTime() + LEASE) },
      ...{ released: false, yielded: false, superseded: false, finished: false },
      ...{ previousHolder: null, previousToken: null },
    });
  });

  it("of a lease closed by a check (superseded, yielded, released) names the takeover and clears the flags", async () => {
    await rawDocument("superseded", { token: 5, released: true, yielded: true, superseded: true });
    const taken = await (
      await leasesOn(new HandClock(), "instance-2")
    ).acquire("default", "superseded", LEASE);

    expect(taken).toMatchObject({
      token: 6,
      takenOverFrom: { holderInstanceId: "instance-1", token: 5 },
    });
    expect(await storedOf("superseded")).toMatchObject({
      ...{ token: 6, released: false, yielded: false },
      ...{ previousHolder: "instance-1", previousToken: 5 },
    });
    const connection = await instanceConnection(database, "instance-1");
    expect(
      await connection.db
        .collection<{ _id: string }>(Collections.ExecutionLeases)
        .findOne({ _id: treeIdOf("default", "superseded") }, { projection: { superseded: 1 } }),
    ).toMatchObject({ superseded: false });
  });

  it("of a document with no token at all is no takeover of a lease: none is named", async () => {
    await rawDocument("tokenless", { released: false });

    const taken = await (
      await leasesOn(new HandClock(), "instance-2")
    ).acquire("default", "tokenless", LEASE);

    expect(taken).toMatchObject({ token: 1 });
    expect(taken?.takenOverFrom).toBeUndefined();
    expect(await storedOf("tokenless")).toMatchObject({
      ...{ token: 1, previousHolder: null, previousToken: null },
    });
  });
});

describe("agbossjs/agboss#81: a lease is held by its token", () => {
  it("a leaseEpoch counts only where the document has no token", async () => {
    const clock = new HandClock();
    const expiresAt = new Date(clock.now().getTime() + LEASE);
    await rawDocument("both", { token: 9, leaseEpoch: 3, released: false, expiresAt });

    expect(
      await (await leasesOn(clock)).renew(heldAt("both", 3, expiresAt), LEASE),
    ).toBeUndefined();
    expect(await (await leasesOn(clock)).renew(heldAt("both", 9, expiresAt), LEASE)).toBe(LEASE);
  });
});

describe("agbossjs/agboss#81: the claim of an execution id", () => {
  it("stores the id with the tenant that made it", async () => {
    const leases = await leasesOn(new StoreClock(StoreTimeSource.Database));

    expect(await leases.claimExecutionId({ executionId: "claimed-1", tenantId: "acme" })).toBe(
      true,
    );

    const connection = await instanceConnection(database, "instance-1");
    expect(
      await connection.db
        .collection<{ _id: string }>(Collections.ExecutionIds)
        .findOne({ _id: "claimed-1" }),
    ).toEqual({ _id: "claimed-1", tenantId: "acme" });
  });
});
