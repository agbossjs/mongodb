/**
 * agbossjs/agboss#847 (G7) on MongoDB:
 * - a lease document written by 0.1.0 names its fencing token `leaseEpoch`: it is renewed, yielded,
 *   reclaimed, fenced, retired and taken over by that token, and the store's next write of it
 *   stores `token` and drops `leaseEpoch` (never both); a new tree's document is written with
 *   `token` only;
 * - in production (`StoreTimeSource.Database`) every lease command decides by the server's `$$NOW`:
 *   the store is handed a `StoreClock` whose host clock throws, so a single read of host time for
 *   a lease — what a store reading the removed `isDatabaseTime` did silently — fails the case.
 */
import {
  ExecutionFencedError,
  FencedEffectSettings,
  StoreClock,
  StoreTimeSource,
  type ExecutionLease,
} from "@agboss/core";
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { seconds } from "@agboss/core/units";
import { beforeEach, describe, expect, it } from "vitest";
import { MongoExecutionLeaseRepository, MongoFencedEffectRepository } from "../../src/index.js";
import { HandClock } from "../contracts/lease-races.js";
import { instanceConnection } from "../contracts/mongodb-store.js";
import { TestApplicationContext } from "../support/application-context.js";
import { emptyAll, testDatabase } from "../support/database.js";

const database = testDatabase();
const LEASE = seconds(30);
const LEASES = "agboss_execution_leases";

beforeEach(() => emptyAll(database.url()));

const leasesOn = async (instanceId: string, clock: StoreClock) =>
  new MongoExecutionLeaseRepository(
    await instanceConnection(database, instanceId),
    clock,
    new TestApplicationContext({}, instanceId),
  );

/** The stored token fields of `root`'s lease document. */
async function tokenFieldsOf(root: string): Promise<unknown> {
  const connection = await instanceConnection(database, "instance-1");
  return connection.db
    .collection<{ _id: string }>(LEASES)
    .findOne({ _id: `default:${root}` }, { projection: { _id: 0, token: 1, leaseEpoch: 1 } });
}

/** A lease document of instance-1 on `root` at `epoch`, as 0.1.0 wrote it (no `token`). */
async function oldDocument(
  root: string,
  epoch: number,
  expiresAt: Date,
  flags: { released?: boolean; finished?: boolean } = {},
): Promise<void> {
  const connection = await instanceConnection(database, "instance-1");
  await connection.db.collection<{ _id: string } & Record<string, unknown>>(LEASES).insertOne({
    _id: `default:${root}`,
    ...{ tenantId: "default", rootExecutionId: root, holderInstanceId: "instance-1" },
    leaseEpoch: epoch,
    expiresAt,
    released: flags.released ?? false,
    yielded: false,
    superseded: false,
    finished: flags.finished ?? false,
    previousHolder: null,
    previousEpoch: null,
  });
}

const leaseOf = (root: string, token: number, expiresAt: Date): ExecutionLease => ({
  ...{ tenantId: "default", rootExecutionId: root, holderInstanceId: "instance-1" },
  ...{ token, expiresAt, remaining: LEASE },
});

describe("#847: a 0.1.0 lease document (leaseEpoch) is read by its token", () => {
  it("renewed, yielded, reclaimed and retired by its token; the write stores token, drops leaseEpoch", async () => {
    const clock = new HandClock();
    const expiresAt = new Date(clock.now().getTime() + LEASE);
    await oldDocument("old-held", 7, expiresAt);
    const holder = await leasesOn("instance-1", clock);
    const other = await leasesOn("instance-2", clock);
    const held = leaseOf("old-held", 7, expiresAt);

    expect(await other.acquire("default", "old-held", LEASE)).toBeUndefined();
    expect(await holder.renew({ ...held, token: 6 }, LEASE)).toBeUndefined();
    expect(await tokenFieldsOf("old-held")).toEqual({ leaseEpoch: 7 });
    await clock.advance(seconds(10));
    expect(await holder.yield(held)).toBe(seconds(20));
    expect(await tokenFieldsOf("old-held")).toEqual({ token: 7 });
    const reclaimed = await holder.reclaim(held, LEASE);
    expect(reclaimed).toMatchObject({ token: 8, remaining: LEASE });
    if (reclaimed === undefined) return;
    expect(await holder.renew(reclaimed, LEASE)).toBe(LEASE);
    await holder.retire(reclaimed);
    await clock.advance(seconds(60));
    expect(await other.acquire("default", "old-held", LEASE)).toBeUndefined();
    expect(await tokenFieldsOf("old-held")).toEqual({ token: 8 });
  });

  it("an expired one is taken over at its token + 1, naming it; a released one at token + 1; a finished one never", async () => {
    const clock = new HandClock();
    const expiresAt = new Date(clock.now().getTime() + LEASE);
    await oldDocument("old-expired", 3, expiresAt);
    await oldDocument("old-released", 5, expiresAt, { released: true });
    await oldDocument("old-finished", 2, expiresAt, { released: true, finished: true });
    const other = await leasesOn("instance-2", clock);
    await clock.advance(LEASE);

    expect(await other.acquire("default", "old-expired", LEASE)).toMatchObject({
      token: 4,
      takenOverFrom: { holderInstanceId: "instance-1", token: 3 },
    });
    expect(await other.acquire("default", "old-released", LEASE)).toMatchObject({ token: 6 });
    expect(await other.acquire("default", "old-released", LEASE)).toBeUndefined();
    expect(await other.acquire("default", "old-finished", LEASE)).toBeUndefined();
    expect(await tokenFieldsOf("old-expired")).toEqual({ token: 4 });
    expect(await tokenFieldsOf("old-released")).toEqual({ token: 6 });
  });

  it("released by its token: a later take is token + 1, no takeover named", async () => {
    const clock = new HandClock();
    const expiresAt = new Date(clock.now().getTime() + LEASE);
    await oldDocument("old-release", 9, expiresAt);
    await (await leasesOn("instance-1", clock)).release(leaseOf("old-release", 9, expiresAt));

    const taken = await (
      await leasesOn("instance-2", clock)
    ).acquire("default", "old-release", LEASE);

    expect(taken).toMatchObject({ token: 10 });
    expect(taken?.takenOverFrom).toBeUndefined();
  });

  it("a fenced write passes at its token and is refused at another", async () => {
    const clock = new HandClock();
    await oldDocument("old-fenced", 4, new Date(clock.now().getTime() + LEASE));
    const effects = new MongoFencedEffectRepository(
      await instanceConnection(database, "instance-1"),
      clock,
      new FencedEffectSettings(),
    );
    const keyAt = (token: number, step: number) =>
      effectKeyForTesting({
        ...{ scopeKey: "default:old-fenced", tenantId: "default", leaseExecutionId: "old-fenced" },
        ...{ token, idempotencyKey: `old-fenced:charge-action:${String(step)}`, name: "charge" },
      });

    await expect(
      effects.saveResultIfAbsent(keyAt(4, 1), () => Promise.resolve({ receipt: "ok" })),
    ).resolves.toBeDefined();
    await expect(
      effects.saveResultIfAbsent(keyAt(3, 2), () => Promise.resolve({ receipt: "stale" })),
    ).rejects.toBeInstanceOf(ExecutionFencedError);
  });

  it("a new tree's document has token only", async () => {
    const leases = await leasesOn("instance-1", new HandClock());

    expect(await leases.acquire("default", "new-tree", LEASE)).toMatchObject({ token: 1 });
    expect(await tokenFieldsOf("new-tree")).toEqual({ token: 1 });
  });
});

describe("#847: in StoreTimeSource.Database a lease is decided by the server's time only", () => {
  /** The production store clock on a host clock that must never be read for a lease. */
  const databaseTime = new StoreClock(StoreTimeSource.Database, {
    now: () => {
      throw new Error("a lease decided by the host's clock in StoreTimeSource.Database");
    },
  });

  it("acquire, renew, yield, reclaim, release and retire never read the host clock", async () => {
    const leases = await leasesOn("instance-1", databaseTime);
    const other = await leasesOn("instance-2", databaseTime);
    const lease = await leases.acquire("default", "db-time-1", LEASE);

    expect(lease?.remaining).toBe(LEASE);
    if (lease === undefined) return;
    expect(await leases.renew(lease, LEASE)).toBe(LEASE);
    expect(await leases.yield(lease)).toBeLessThanOrEqual(LEASE);
    const reclaimed = await leases.reclaim(lease, LEASE);
    expect(reclaimed).toMatchObject({ token: lease.token + 1, remaining: LEASE });
    if (reclaimed === undefined) return;
    expect(await other.acquire("default", "db-time-1", LEASE)).toBeUndefined();
    await leases.release(reclaimed);
    const retiring = await leases.acquire("default", "db-time-2", LEASE);
    expect(retiring).toBeDefined();
    if (retiring !== undefined) await leases.retire(retiring);
    expect(await other.acquire("default", "db-time-2", LEASE)).toBeUndefined();
  });
});
