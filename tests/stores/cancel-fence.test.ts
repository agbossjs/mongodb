/**
 * agbossjs/agboss#909, #1117 on MongoDB: a tree's cancel mark is the field `cancelRequestedAt` of
 * the tree's own lease document — permanent, a seed document (token 0, released) when the cancel
 * comes before the first `acquire`. A fenced write **writes** the root's document before it reads
 * the mark, so a cancel either waits for the open fencing transaction (the write lands first) or
 * commits before it and is read — never the write landing after the cancel answered.
 */
import {
  ExecutionCancelFencedError,
  FencedEffectSettings,
  FencedEffectStatus,
  StoreClock,
  StoreTimeSource,
  type ExecutionLease,
} from "@agboss/core";
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { hours, seconds } from "@agboss/core/units";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Collections,
  MongoExecutionLeaseRepository,
  MongoFencedEffectRepository,
  MongoOutboundCallRepository,
  type MongoConnection,
} from "../../src/index.js";
import { treeIdOf } from "../../src/stores/keys.js";
import { HandClock } from "../contracts/lease-races.js";
import { instanceConnection } from "../contracts/mongodb-store.js";
import { TestApplicationContext } from "../support/application-context.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { CancelCheckEffects, outsideTransaction, readOnly } from "./cancel-sabotage.js";

const database = testDatabase();
const LEASE = hours(1);
const TENANT = "default";

beforeEach(() => emptyAll(database.url()));

const clockOf = (): { clock: HandClock; store: StoreClock } => {
  const clock = new HandClock();
  return { clock, store: new StoreClock(StoreTimeSource.Test, clock) };
};

/** One instance's stores on `store`'s clock. */
async function instance(instanceId: string, store: StoreClock) {
  const connection = await instanceConnection(database, instanceId);
  return {
    connection,
    leases: new MongoExecutionLeaseRepository(
      connection,
      store,
      new TestApplicationContext({}, instanceId),
    ),
    effects: new MongoFencedEffectRepository(connection, store, new FencedEffectSettings()),
    calls: new MongoOutboundCallRepository(connection, store),
  };
}

/** The key of one effect `name` under `lease`, of the tree of `root` (a child's key names its root). */
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

/** The lease of a take that must have succeeded. */
function leased(lease: ExecutionLease | undefined): ExecutionLease {
  if (lease === undefined) throw new Error("the take was refused");
  return lease;
}

const tree = (root: string) => ({ tenantId: TENANT, rootExecutionId: root });

const documentOf = async (connection: MongoConnection, root: string): Promise<unknown> =>
  connection.db
    .collection<{ _id: string }>(Collections.ExecutionLeases)
    .findOne({ _id: treeIdOf(TENANT, root) }, { projection: { _id: 0 } });

/** Whether `promise` settled within `ms` of real time. */
const settledWithin = (promise: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, ms);
    }),
  ]);

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("agbossjs/agboss#1117: the mark is a field of the tree's lease document", () => {
  it("a cancel before the first acquire writes a seed document — token 0, released, no holder — and the first acquire is token 1, no takeover", async () => {
    const { store } = clockOf();
    const one = await instance("instance-1", store);

    await one.leases.requestCancel(tree("seeded"));

    expect(await documentOf(one.connection, "seeded")).toMatchObject({
      tenantId: TENANT,
      rootExecutionId: "seeded",
      holderInstanceId: "",
      token: 0,
      released: true,
      yielded: false,
      superseded: false,
      finished: false,
      cancelRequestedAt: expect.any(Date) as Date,
    });
    const first = await one.leases.acquire(TENANT, "seeded", LEASE);
    expect(first).toMatchObject({ token: 1, holderInstanceId: "instance-1" });
    expect(first?.takenOverFrom).toBeUndefined();
  });

  it("a repeat keeps the first time; a cancel of a held lease changes nothing of the lease", async () => {
    const { clock, store } = clockOf();
    const one = await instance("instance-1", store);
    const held = leased(await one.leases.acquire(TENANT, "held", LEASE));
    const before = await documentOf(one.connection, "held");

    await one.leases.requestCancel(tree("held"));
    const marked = await documentOf(one.connection, "held");
    await clock.advance(seconds(5));
    await one.leases.requestCancel(tree("held"));

    expect(marked).toEqual({ ...(before as object), cancelRequestedAt: expect.any(Date) as Date });
    expect(await documentOf(one.connection, "held")).toEqual(marked);
    expect(await one.leases.renew(held, LEASE)).toBe(LEASE);
  });

  it("every write of the document keeps the mark: release, take, retire, a 0.1.0 document's rename", async () => {
    const { clock, store } = clockOf();
    const one = await instance("instance-1", store);
    const two = await instance("instance-2", store);
    const first = leased(await one.leases.acquire(TENANT, "moves", LEASE));
    await two.leases.requestCancel(tree("moves"));
    const mark = (await documentOf(one.connection, "moves")) as { cancelRequestedAt: Date };

    await one.leases.release(first);
    const taken = leased(await two.leases.acquire(TENANT, "moves", LEASE));
    await clock.advance(LEASE + 1);
    const over = leased(await one.leases.acquire(TENANT, "moves", LEASE));
    await one.leases.retire(over);

    expect([taken.token, over.token]).toEqual([2, 3]);
    expect(await documentOf(one.connection, "moves")).toMatchObject({
      cancelRequestedAt: mark.cancelRequestedAt,
      finished: true,
    });
  });

  it("the retention of the fenced stores lifts nothing, at any cutoff", async () => {
    const { clock, store } = clockOf();
    const one = await instance("instance-1", store);
    const lease = leased(await one.leases.acquire(TENANT, "kept", LEASE));
    await one.leases.requestCancel(tree("kept"));
    await clock.advance(hours(48));
    await one.leases.retire(lease);

    await one.effects.deleteByStoredAtBefore(new Date(clock.now().getTime() + hours(24)));
    await one.calls.deleteByEndedAtBefore(new Date(clock.now().getTime() + hours(24)));

    expect(await documentOf(one.connection, "kept")).toMatchObject({
      cancelRequestedAt: expect.any(Date) as Date,
    });
  });
});

describe("agbossjs/agboss#909: the cancel and an open fencing transaction", () => {
  it("a cancel waits for the root's open transaction: the write lands first, the next is refused", async () => {
    const { store } = clockOf();
    const one = await instance("instance-1", store);
    const two = await instance("instance-2", store);
    const lease = leased(await one.leases.acquire(TENANT, "wait", LEASE));
    let open = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    let isInside = (): void => undefined;
    const inside = new Promise<void>((resolve) => {
      isInside = resolve;
    });

    const write = one.effects.runOnce(keyOf(lease, "first"), async () => {
      isInside();
      await opened;
      return { receipt: "r1" };
    });
    await inside;
    const cancel = two.leases.requestCancel(tree("wait"));

    expect(await settledWithin(cancel, 600)).toBe(false);
    open();
    const written = await write;
    await cancel;

    expect(written.status).toBe(FencedEffectStatus.Ran);
    const later = await rejection(one.effects.runOnce(keyOf(lease, "later"), () => ({ r: 2 })));
    expect(later).toBeInstanceOf(ExecutionCancelFencedError);
  });

  /** A child's write held open inside its transaction, the root's document not yet there; the cancel from another instance. */
  async function childInsideAndCancel(
    effects: { runOnce: MongoFencedEffectRepository["runOnce"] },
    cancelFrom: MongoExecutionLeaseRepository,
    child: ExecutionLease,
  ) {
    let open = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    let isInside = (): void => undefined;
    const inside = new Promise<void>((resolve) => {
      isInside = resolve;
    });
    const write = effects.runOnce(keyOf(child, "charge", "root-r"), async () => {
      isInside();
      await opened;
      return { receipt: "r1" };
    });
    await inside;
    const cancel = cancelFrom.requestCancel(tree("root-r"));
    const answeredInside = await settledWithin(cancel, 600);
    open();
    await write;
    await cancel;
    return answeredInside;
  }

  it("a child whose root has no document yet seeds it in its transaction: the cancel waits for the child's write, then refuses the next", async () => {
    const { store } = clockOf();
    const one = await instance("instance-1", store);
    const two = await instance("instance-2", store);
    const child = leased(await one.leases.acquire(TENANT, "child-r1", LEASE));

    const answeredInside = await childInsideAndCancel(one.effects, two.leases, child);

    expect(answeredInside).toBe(false);
    expect(await documentOf(one.connection, "root-r")).toMatchObject({
      token: 0,
      released: true,
      cancelRequestedAt: expect.any(Date) as Date,
    });
    const later = await rejection(
      one.effects.runOnce(keyOf(child, "later", "root-r"), () => ({ r: 2 })),
    );
    expect(later).toBeInstanceOf(ExecutionCancelFencedError);
  });

  it("sabotage: a child's check that only reads the root's document lets the cancel answer inside the child's open write", async () => {
    const { store } = clockOf();
    const one = await instance("instance-1", store);
    const two = await instance("instance-2", store);
    const reading = new CancelCheckEffects(
      one.connection,
      store,
      readOnly,
      new FencedEffectSettings(),
    );
    const child = leased(await one.leases.acquire(TENANT, "child-r1", LEASE));

    const answeredInside = await childInsideAndCancel(reading, two.leases, child);

    expect(answeredInside).toBe(true);
  });

  it("sabotage: a child's check that reads the root's document outside the transaction lets the cancel answer inside the child's open write", async () => {
    const { store } = clockOf();
    const one = await instance("instance-1", store);
    const two = await instance("instance-2", store);
    const outside = new CancelCheckEffects(
      one.connection,
      store,
      outsideTransaction,
      new FencedEffectSettings(),
    );
    const child = leased(await one.leases.acquire(TENANT, "child-r1", LEASE));

    const answeredInside = await childInsideAndCancel(outside, two.leases, child);

    expect(answeredInside).toBe(true);
  });

  it("a root's first lease is token 1 with no takeover after the child seeded its document", async () => {
    const { store } = clockOf();
    const one = await instance("instance-1", store);
    const child = leased(await one.leases.acquire(TENANT, "child-r2", LEASE));
    await one.effects.runOnce(keyOf(child, "charge", "root-q"), () => ({ receipt: "r" }));

    const root = await one.leases.acquire(TENANT, "root-q", LEASE);

    expect(root).toMatchObject({ token: 1 });
    expect(root?.takenOverFrom).toBeUndefined();
  });
});

describe("agbossjs/agboss#1117: a first acquire racing a cancel's seed", () => {
  it("the acquire is never refused for a seed document: token 1, the mark set — a tree nobody holds is always takeable", async () => {
    const { store } = clockOf();
    const one = await instance("instance-1", store);
    const two = await instance("instance-2", store);
    const rounds = 120;

    const taken = await Promise.all(
      Array.from({ length: rounds }, async (_unused, round) => {
        const root = `race-${String(round)}`;
        const [lease] = await Promise.all([
          one.leases.acquire(TENANT, root, LEASE),
          two.leases.requestCancel(tree(root)),
        ]);
        return { root, lease };
      }),
    );

    for (const { root, lease } of taken) {
      expect(lease, root).toMatchObject({ token: 1 });
      expect(lease?.takenOverFrom, root).toBeUndefined();
      expect(await documentOf(one.connection, root), root).toMatchObject({
        cancelRequestedAt: expect.any(Date) as Date,
        token: 1,
      });
    }
  });
});
