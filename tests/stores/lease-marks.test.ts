/**
 * agbossjs/agboss#1341b, #1341c on MongoDB: the stop and pause marks of a tree are fields of its
 * lease document, each written by ONE update the server runs on the document as it is — monotone in
 * the update itself, never a read of the client written back. So two writers racing one mark cannot
 * weaken it: `immediate` stays `immediate` whatever order two requests arrive in, the fence only
 * rises, the first request's time and the cancel mark stay. A mark that carries a history entry
 * writes both in one transaction.
 */
import {
  InterruptMode,
  StatusTrigger,
  StoreClock,
  StoreTimeSource,
  ThreadStatus,
  type NewStatusTransition,
} from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { hours } from "@agboss/core/units";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Collections,
  MongoExecutionLeaseRepository,
  MongoExecutionRecordRepository,
  type MongoConnection,
} from "../../src/index.js";
import { treeIdOf } from "../../src/stores/keys.js";
import type { LeaseDocument } from "../../src/stores/lease-documents.js";
import { HandClock } from "../contracts/lease-races.js";
import { instanceConnection } from "../contracts/mongodb-store.js";
import { TestApplicationContext } from "../support/application-context.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { CountingIdGenerator } from "../support/stores.js";

const database = testDatabase();
const TENANT = "default";
const LEASE = hours(1);
const WRITERS = 6;
const ROUNDS = 12;

beforeEach(() => emptyAll(database.url()));

const tree = (root: string) => ({ tenantId: TENANT, rootExecutionId: root });

async function instance(instanceId: string) {
  const clock = new HandClock();
  const store = new StoreClock(StoreTimeSource.Test, clock);
  const connection = await instanceConnection(database, instanceId);
  return {
    clock,
    connection,
    leases: new MongoExecutionLeaseRepository(
      connection,
      store,
      new TestApplicationContext({}, instanceId),
    ),
    records: new MongoExecutionRecordRepository(
      connection,
      new VirtualClock(),
      new TestApplicationContext({}, instanceId),
      new CountingIdGenerator(),
    ),
  };
}

/** `count` instances on one database and one hand clock. */
async function instances(count: number) {
  const clock = new HandClock();
  const store = new StoreClock(StoreTimeSource.Test, clock);
  return Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const instanceId = `instance-${String(index)}`;
      const connection = await instanceConnection(database, instanceId);
      return new MongoExecutionLeaseRepository(
        connection,
        store,
        new TestApplicationContext({}, instanceId),
      );
    }),
  );
}

const documentOf = async (connection: MongoConnection, root: string) =>
  connection.db
    .collection<LeaseDocument>(Collections.ExecutionLeases)
    .findOne({ _id: treeIdOf(TENANT, root) });

/** Runs every call at once, released together. */
async function together(calls: readonly (() => Promise<unknown>)[]): Promise<void> {
  let release: () => void = () => undefined;
  const go = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = calls.map(async (call) => {
    await go;
    await call();
  });
  release();
  await Promise.all(running);
}

const transition = (toStatus: ThreadStatus, trigger: StatusTrigger): NewStatusTransition => ({
  tenantId: TENANT,
  threadId: "thread-1",
  toStatus,
  trigger,
});

describe("a stop only escalates, whatever order concurrent requests arrive in", () => {
  it("two concurrent stops, after-step and immediate, in either order, end immediate", async () => {
    const [one, two] = await instances(2);
    if (one === undefined || two === undefined) throw new Error("no instances");
    for (let round = 0; round < ROUNDS; round += 1) {
      const root = `race-${String(round)}`;
      const calls = [
        () => one.requestStop(tree(root), InterruptMode.AfterStep),
        () => two.requestStop(tree(root), InterruptMode.Immediate),
      ];
      await together(round % 2 === 0 ? calls : [...calls].reverse());

      expect(await one.stopOf(tree(root))).toEqual({ mode: InterruptMode.Immediate });
    }
  });

  it("many writers of both modes at once end immediate, and the first request's time is kept", async () => {
    const stores = await instances(WRITERS);
    const root = "many";
    await together(
      stores.map(
        (store, index) => () =>
          store.requestStop(
            tree(root),
            index % 2 === 0 ? InterruptMode.AfterStep : InterruptMode.Immediate,
          ),
      ),
    );

    expect(await stores[0]?.stopOf(tree(root))).toEqual({ mode: InterruptMode.Immediate });
  });

  it("an after-step stop after an immediate one never lowers it; the request time stays the first", async () => {
    const { clock, connection, leases } = await instance("instance-1");
    await leases.requestStop(tree("kept"), InterruptMode.Immediate);
    const first = (await documentOf(connection, "kept"))?.stopRequestedAt;
    await clock.advance(1000);

    await leases.requestStop(tree("kept"), InterruptMode.AfterStep);

    expect(await leases.stopOf(tree("kept"))).toEqual({ mode: InterruptMode.Immediate });
    expect((await documentOf(connection, "kept"))?.stopRequestedAt).toEqual(first);
  });

  it("an after-step stop is escalated by an immediate one", async () => {
    const { leases } = await instance("instance-1");
    await leases.requestStop(tree("escalated"), InterruptMode.AfterStep);
    expect(await leases.stopOf(tree("escalated"))).toEqual({ mode: InterruptMode.AfterStep });

    await leases.requestStop(tree("escalated"), InterruptMode.Immediate);

    expect(await leases.stopOf(tree("escalated"))).toEqual({ mode: InterruptMode.Immediate });
  });
});

describe("a pause: its mode only escalates and its fence only rises", () => {
  it("two concurrent pauses, after-step and immediate, in either order, end immediate and fence the lease token", async () => {
    const [one, two] = await instances(2);
    if (one === undefined || two === undefined) throw new Error("no instances");
    for (let round = 0; round < ROUNDS; round += 1) {
      const root = `pause-${String(round)}`;
      const lease = await one.acquire(TENANT, root, LEASE);
      const calls = [
        () => one.requestPause(tree(root), { mode: InterruptMode.AfterStep }),
        () => two.requestPause(tree(root), { mode: InterruptMode.Immediate, reason: "audit" }),
      ];
      await together(round % 2 === 0 ? calls : [...calls].reverse());

      const marks = await one.pauseOf(tree(root));
      expect(marks.pause?.mode).toBe(InterruptMode.Immediate);
      expect(marks.fencedThroughToken).toBe(lease?.token);
    }
  });

  it("the fence is never lowered by a later after-step pause, nor cleared by an unpause", async () => {
    const { leases } = await instance("instance-1");
    const lease = await leases.acquire(TENANT, "fence", LEASE);
    await leases.requestPause(tree("fence"), { mode: InterruptMode.Immediate });
    await leases.unpause(tree("fence"));
    expect(await leases.pauseOf(tree("fence"))).toEqual({ fencedThroughToken: lease?.token });

    await leases.requestPause(tree("fence"), { mode: InterruptMode.AfterStep });

    expect(await leases.pauseOf(tree("fence"))).toEqual({
      pause: { mode: InterruptMode.AfterStep },
      fencedThroughToken: lease?.token,
    });
  });

  it("a pause before the first acquire seeds a document, fenced through token 0; the first acquire is token 1", async () => {
    const { leases } = await instance("instance-1");

    await leases.requestPause(tree("seeded"), { mode: InterruptMode.Immediate, reason: "hold" });

    expect(await leases.pauseOf(tree("seeded"))).toEqual({
      pause: { mode: InterruptMode.Immediate, reason: "hold" },
      fencedThroughToken: 0,
    });
    expect((await leases.acquire(TENANT, "seeded", LEASE))?.token).toBe(1);
  });

  it("an immediate pause stays immediate while paused: an after-step request in between changes the reason, not the mode", async () => {
    const { leases } = await instance("instance-1");
    await leases.requestPause(tree("held"), { mode: InterruptMode.Immediate, reason: "a" });

    await leases.requestPause(tree("held"), { mode: InterruptMode.AfterStep, reason: "b" });

    expect((await leases.pauseOf(tree("held"))).pause).toEqual({
      mode: InterruptMode.Immediate,
      reason: "b",
    });
  });

  it("markedOf answers the cancel, the stop and the pause of the tree in one read", async () => {
    const { leases, connection } = await instance("instance-1");
    await leases.acquire(TENANT, "all", LEASE);
    await leases.requestCancel(tree("all"));
    await leases.requestStop(tree("all"), InterruptMode.AfterStep);
    await leases.requestPause(tree("all"), { mode: InterruptMode.Immediate });
    expect(await documentOf(connection, "all")).not.toBeNull();

    expect(await leases.markedOf(tree("all"))).toEqual({
      isCancelRequested: true,
      stop: { mode: InterruptMode.AfterStep },
      pause: { mode: InterruptMode.Immediate },
      fencedThroughToken: 1,
    });
    expect(await leases.markedOf(tree("none"))).toEqual({ isCancelRequested: false });
  });
});

describe("a mark with its status entry is one transaction", () => {
  it("the stop, the pause, the unpause and the cancel each write their entry once, in order", async () => {
    const { leases, records } = await instance("instance-1");
    const t = tree("history");

    await leases.requestStop(
      t,
      InterruptMode.AfterStep,
      transition(ThreadStatus.Stopping, StatusTrigger.Stop),
    );
    // a repeat of a command that changes nothing writes no entry; an escalation does not either
    // (the thread is stopping either way)
    await leases.requestStop(
      t,
      InterruptMode.AfterStep,
      transition(ThreadStatus.Stopping, StatusTrigger.Stop),
    );
    await leases.requestPause(
      t,
      { mode: InterruptMode.AfterStep },
      transition(ThreadStatus.Pausing, StatusTrigger.Pause),
    );
    await leases.requestPause(
      t,
      { mode: InterruptMode.AfterStep },
      transition(ThreadStatus.Pausing, StatusTrigger.Pause),
    );
    await leases.unpause(t, transition(ThreadStatus.Running, StatusTrigger.Unpause));
    await leases.unpause(t, transition(ThreadStatus.Running, StatusTrigger.Unpause));
    await leases.requestCancel(t, transition(ThreadStatus.Cancelling, StatusTrigger.Cancel));
    await leases.requestCancel(t, transition(ThreadStatus.Cancelling, StatusTrigger.Cancel));

    const history = await records.statusHistory(TENANT, "thread-1");
    expect(history.map((entry) => [entry.seq, entry.toStatus, entry.trigger])).toEqual([
      [1, ThreadStatus.Stopping, StatusTrigger.Stop],
      [2, ThreadStatus.Pausing, StatusTrigger.Pause],
      [3, ThreadStatus.Running, StatusTrigger.Unpause],
      [4, ThreadStatus.Cancelling, StatusTrigger.Cancel],
    ]);
  });

  it("a mark whose entry cannot be written (a clash on the entry's id) leaves the mark unwritten", async () => {
    const { leases, connection, records } = await instance("instance-1");
    const t = tree("atomic");
    await leases.requestStop(
      t,
      InterruptMode.AfterStep,
      transition(ThreadStatus.Stopping, StatusTrigger.Stop),
    );
    // a history entry already stored where the next would go: its insert fails the transaction
    await connection.db
      .collection<{ _id: string; tenantId: string; threadId: string; seq: number }>(
        Collections.ThreadStatusTransitions,
      )
      .insertOne({
        _id: JSON.stringify([TENANT, "thread-1", 2]),
        tenantId: TENANT,
        threadId: "other",
        seq: 99,
      });

    await expect(
      leases.requestPause(
        t,
        { mode: InterruptMode.Immediate },
        transition(ThreadStatus.Pausing, StatusTrigger.Pause),
      ),
    ).rejects.toThrow();

    expect((await leases.pauseOf(t)).pause).toBeUndefined();
    expect(await records.statusHistory(TENANT, "thread-1")).toHaveLength(1);
  });

  it("concurrent writers of one thread's entries never write one seq twice", async () => {
    const stores = await instances(WRITERS);
    const statuses: readonly [ThreadStatus, StatusTrigger][] = [
      [ThreadStatus.Stopping, StatusTrigger.Stop],
      [ThreadStatus.Pausing, StatusTrigger.Pause],
      [ThreadStatus.Cancelling, StatusTrigger.Cancel],
    ];
    await together(
      stores.map((store, index) => () => {
        const [status, trigger] = statuses[index % statuses.length] ??
          statuses[0] ?? [ThreadStatus.Stopping, StatusTrigger.Stop];
        return index % 3 === 0
          ? store.requestStop(
              tree(`own-${String(index)}`),
              InterruptMode.AfterStep,
              transition(status, trigger),
            )
          : index % 3 === 1
            ? store.requestPause(
                tree(`own-${String(index)}`),
                { mode: InterruptMode.AfterStep },
                transition(status, trigger),
              )
            : store.requestCancel(tree(`own-${String(index)}`), transition(status, trigger));
      }),
    );

    const connection = await instanceConnection(database, "reader");
    const found = await connection.db
      .collection<{ seq: number }>(Collections.ThreadStatusTransitions)
      .find({ threadId: "thread-1" })
      .sort({ seq: 1 })
      .toArray();
    const seqs = found.map((entry) => entry.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });
});

describe("the cancel mark is never unset", () => {
  it("a stop, a pause, an unpause, a release and a retire leave cancelRequestedAt as it was", async () => {
    const { clock, connection, leases } = await instance("instance-1");
    const lease = await leases.acquire(TENANT, "cancelled", LEASE);
    await leases.requestCancel(tree("cancelled"));
    const first = (await documentOf(connection, "cancelled"))?.cancelRequestedAt;
    await clock.advance(5000);

    await leases.requestStop(tree("cancelled"), InterruptMode.Immediate);
    await leases.requestPause(tree("cancelled"), { mode: InterruptMode.Immediate });
    await leases.unpause(tree("cancelled"));
    await leases.requestCancel(tree("cancelled"));
    if (lease !== undefined) await leases.retire(lease);

    expect((await documentOf(connection, "cancelled"))?.cancelRequestedAt).toEqual(first);
    expect(first).toBeInstanceOf(Date);
  });
});
