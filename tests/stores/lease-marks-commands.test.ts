/**
 * The lease store's marks, the status history they write and the cluster mirror, as the client sends
 * and reads them, on a recording fake (no server): each command whole, each answer for each shape of
 * document, each history document only when the mark changed something.
 */
import {
  InterruptMode,
  StatusTrigger,
  StoreClock,
  StoreTimeSource,
  ThreadStatus,
  type ExecutionLease,
} from "@agboss/core";
import { ClusterLeaseSyncOutcome, MirroredLeaseState, StoreError } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collections, MongoExecutionLeaseRepository } from "../../src/index.js";
import { idOf } from "../../src/stores/keys.js";
import { liftPause, markPause, markStop } from "../../src/stores/lease-marks.js";
import { orSeed, seedStages } from "../../src/stores/lease-seed.js";
import { recordTransitionOf, transitionOfDocument } from "../../src/stores/status-log.js";
import { literal } from "../../src/stores/store-time.js";
import { TestApplicationContext } from "../support/application-context.js";

const statusWritten = vi.hoisted(() => vi.fn());

vi.mock("../../src/stores/status-log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/stores/status-log.js")>()),
  appendStatus: statusWritten,
}));

beforeEach(() => {
  statusWritten.mockClear();
});

const CLOCK = new StoreClock(StoreTimeSource.Test, new VirtualClock());
const TREE = { tenantId: "default", rootExecutionId: "root-1" };
const SESSION = { id: "session" } as never;
const NOW = new Date("2026-01-05T09:00:00.000Z");
const ID = idOf("default", "root-1");
const TRANSITION = {
  tenantId: "default",
  threadId: "t-1",
  toStatus: ThreadStatus.Paused,
  trigger: StatusTrigger.Pause,
};

interface Answers {
  /** The document before a mark's update (`findOneAndUpdate`). */
  readonly before?: object | null;
  /** The document a read answers (`findOne`). */
  readonly found?: object | null;
  readonly modified?: number;
  readonly updateError?: Error;
}

/** A fake database logging `[collection, method, ...args]`. */
function recording(answers: Answers = {}) {
  const log: unknown[][] = [];
  const collection = (name: string) => ({
    findOneAndUpdate: (...args: unknown[]) => {
      log.push([name, "findOneAndUpdate", ...args]);
      if (answers.updateError !== undefined) return Promise.reject(answers.updateError);
      return Promise.resolve(answers.before === undefined ? null : answers.before);
    },
    findOne: (...args: unknown[]) => {
      log.push([name, "findOne", ...args]);
      return Promise.resolve(answers.found === undefined ? null : answers.found);
    },
    updateOne: (...args: unknown[]) => {
      log.push([name, "updateOne", ...args]);
      if (answers.updateError !== undefined) return Promise.reject(answers.updateError);
      return Promise.resolve({ modifiedCount: answers.modified ?? 1, matchedCount: 1 });
    },
    insertOne: (...args: unknown[]) => {
      log.push([name, "insertOne", ...args]);
      return Promise.resolve({});
    },
    deleteMany: (...args: unknown[]) => {
      log.push([name, "deleteMany", ...args]);
      return Promise.resolve({});
    },
    find: (...args: unknown[]) => {
      log.push([name, "find", ...args]);
      const cursor = {
        sort: (sort: unknown) => {
          log.push([name, "sort", sort]);
          return cursor;
        },
        toArray: () => Promise.resolve([]),
      };
      return cursor;
    },
  });
  const db = { collection };
  const connection = {
    db,
    inTransaction: (work: (transaction: unknown) => unknown) =>
      Promise.resolve(work({ db, session: SESSION })),
  } as never;
  return { db: db as never, connection, log };
}

const leasesOn = (connection: never) =>
  new MongoExecutionLeaseRepository(connection, CLOCK, new TestApplicationContext());

describe("what a mark writes to the history: only when it was this call that changed something", () => {
  const withTransition = { clock: CLOCK, transition: TRANSITION };

  it("writes the history document for a transition in a session, and neither without one nor without a session", async () => {
    const { db } = recording();

    await markStop({ db, session: SESSION }, TREE, InterruptMode.Immediate, withTransition);
    expect(statusWritten).toHaveBeenCalledTimes(1);
    expect(statusWritten.mock.calls[0]?.slice(1)).toStrictEqual([
      SESSION,
      TRANSITION,
      expect.any(Date),
    ]);

    statusWritten.mockClear();
    await markStop({ db, session: SESSION }, TREE, InterruptMode.Immediate, {
      clock: CLOCK,
      transition: undefined,
    });
    await markStop({ db, session: undefined }, TREE, InterruptMode.Immediate, withTransition);
    expect(statusWritten).not.toHaveBeenCalled();
  });

  it.each([
    ["no stop before", null, InterruptMode.AfterStep, true],
    [
      "an after-step stop escalated to immediate",
      { stopMode: "after-step" },
      InterruptMode.Immediate,
      true,
    ],
    ["an after-step stop asked again", { stopMode: "after-step" }, InterruptMode.AfterStep, false],
    ["an immediate stop asked again", { stopMode: "immediate" }, InterruptMode.Immediate, false],
    [
      "an immediate stop asked for after-step",
      { stopMode: "immediate" },
      InterruptMode.AfterStep,
      false,
    ],
  ])("a stop over %s", async (_what, before, mode, isWritten) => {
    const { db } = recording({ before });

    await markStop({ db, session: SESSION }, TREE, mode, withTransition);

    expect(statusWritten).toHaveBeenCalledTimes(isWritten ? 1 : 0);
  });

  it.each([
    ["no pause before", null, true],
    ["a tree not paused", { isExternallyPaused: false }, true],
    ["a tree paused already", { isExternallyPaused: true }, false],
  ])("a pause over %s", async (_what, before, isWritten) => {
    const { db } = recording({ before });

    await markPause(
      { db, session: SESSION },
      TREE,
      { mode: InterruptMode.AfterStep },
      withTransition,
    );

    expect(statusWritten).toHaveBeenCalledTimes(isWritten ? 1 : 0);
  });

  it.each([
    ["a pause lifted", 1, true],
    ["no pause to lift", 0, false],
  ])("an unpause of %s", async (_what, modified, isWritten) => {
    const { db } = recording({ modified });

    await liftPause({ db, session: SESSION }, TREE, withTransition);

    expect(statusWritten).toHaveBeenCalledTimes(isWritten ? 1 : 0);
  });
});

describe("the marks' updates", () => {
  const write = { clock: CLOCK, transition: undefined };

  it("a mark upserts and answers the document as it was, in the session when it has one", async () => {
    const withSession = recording();
    const without = recording();

    await markStop({ db: withSession.db, session: SESSION }, TREE, InterruptMode.Immediate, write);
    await markStop({ db: without.db, session: undefined }, TREE, InterruptMode.Immediate, write);

    expect(withSession.log[0]?.[4]).toStrictEqual({
      upsert: true,
      returnDocument: "before",
      session: SESSION,
    });
    expect(without.log[0]?.[4]).toStrictEqual({ upsert: true, returnDocument: "before" });
  });

  it.each([
    [{ reason: "maintenance", mode: InterruptMode.Immediate }, literal("maintenance"), true],
    [{ mode: InterruptMode.AfterStep }, "$$REMOVE", false],
  ])(
    "a pause request %j sets its reason, its mode and the fence by the rules",
    async (request, reason, isImmediate) => {
      const { db, log } = recording();

      await markPause({ db, session: SESSION }, TREE, request, write);

      const stages = log[0]?.[3] as { $set: Record<string, unknown> }[];
      expect(stages.at(-1)).toStrictEqual({
        $set: {
          isExternallyPaused: true,
          externalPauseReason: reason,
          externalPauseMode: {
            $cond: [
              {
                $and: [
                  { $eq: [{ $ifNull: ["$isExternallyPaused", false] }, true] },
                  { $eq: ["$externalPauseMode", "immediate"] },
                ],
              },
              "immediate",
              literal(request.mode),
            ],
          },
          fencedThroughToken: isImmediate
            ? { $max: [{ $ifNull: ["$fencedThroughToken", 0] }, "$token"] }
            : "$fencedThroughToken",
        },
      });
    },
  );

  it("an unpause updates a paused tree's document, clears the reason and the mode, in the session when it has one", async () => {
    const withSession = recording();
    const without = recording();

    await liftPause({ db: withSession.db, session: SESSION }, TREE, write);
    await liftPause({ db: without.db, session: undefined }, TREE, write);

    const command = [
      Collections.ExecutionLeases,
      "updateOne",
      { _id: ID, isExternallyPaused: true },
      {
        $set: { isExternallyPaused: false },
        $unset: { externalPauseReason: "", externalPauseMode: "" },
      },
    ];
    expect(withSession.log[0]).toStrictEqual([...command, { session: SESSION }]);
    expect(without.log[0]).toStrictEqual([...command, {}]);
  });
});

describe("the marks a read answers", () => {
  const read = async (found: object | null) =>
    leasesOn(recording({ found }).connection).markedOf(TREE);

  it("none for a tree with no document", async () => {
    expect(await read(null)).toStrictEqual({ isCancelRequested: false });
  });

  it("the cancel, the stop with its mode, the pause with its reason and mode, the fence", async () => {
    expect(
      await read({
        cancelRequestedAt: NOW,
        stopMode: "after-step",
        isExternallyPaused: true,
        externalPauseReason: "why",
        externalPauseMode: "immediate",
        fencedThroughToken: 4,
      }),
    ).toStrictEqual({
      isCancelRequested: true,
      stop: { mode: "after-step" },
      pause: { reason: "why", mode: "immediate" },
      fencedThroughToken: 4,
    });
  });

  it("a pause with no reason has none, and a mode that is not immediate is after-step; no pause, no stop, no fence: none", async () => {
    expect(await read({ isExternallyPaused: true })).toStrictEqual({
      isCancelRequested: false,
      pause: { mode: "after-step" },
    });
    expect(await read({ isExternallyPaused: false, externalPauseMode: "immediate" })).toStrictEqual(
      {
        isCancelRequested: false,
      },
    );
  });

  it("the pause and the fence alone, as the lease store answers them", async () => {
    const pauseOf = (found: object | null) =>
      leasesOn(recording({ found }).connection).pauseOf(TREE);

    expect(
      await pauseOf({ isExternallyPaused: true, fencedThroughToken: 2, stopMode: "immediate" }),
    ).toStrictEqual({
      pause: { mode: "after-step" },
      fencedThroughToken: 2,
    });
    expect(await pauseOf({ isExternallyPaused: true })).toStrictEqual({
      pause: { mode: "after-step" },
    });
    expect(await pauseOf({ fencedThroughToken: 2 })).toStrictEqual({ fencedThroughToken: 2 });
    expect(await pauseOf(null)).toStrictEqual({});
  });
});

describe("a mark with no history document is one command, an unknown outcome named by its operation", () => {
  const broken = new Error("the reply was lost");
  const operationOf = async (call: (leases: MongoExecutionLeaseRepository) => Promise<unknown>) => {
    const { connection } = recording({ updateError: broken });
    const failure = await call(leasesOn(connection)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StoreError.OutcomeUnknown);
    return (failure as StoreError.OutcomeUnknown).operation;
  };

  it.each([
    [
      "requestStop",
      (l: MongoExecutionLeaseRepository) => l.requestStop(TREE, InterruptMode.Immediate),
    ],
    [
      "requestPause",
      (l: MongoExecutionLeaseRepository) => l.requestPause(TREE, { mode: InterruptMode.Immediate }),
    ],
    ["unpause", (l: MongoExecutionLeaseRepository) => l.unpause(TREE)],
    ["syncClusterLease", (l: MongoExecutionLeaseRepository) => l.syncClusterLease(LEASE)],
  ])("%s", async (name, call) => {
    expect(await operationOf(call)).toBe(name);
  });
});

const LEASE = {
  tenantId: "default",
  rootExecutionId: "root-1",
  holderInstanceId: "instance-1",
  token: 3,
} as ExecutionLease;

describe("the cluster mirror", () => {
  const duplicate = Object.assign(new Error("duplicate key"), { code: 11000 });

  it("writes the cluster's lease in one upsert above the document's token, or at it for the same holder not released", async () => {
    const { connection, log } = recording();

    expect(await leasesOn(connection).syncClusterLease(LEASE)).toStrictEqual({
      outcome: ClusterLeaseSyncOutcome.Synced,
    });

    const [, , filter, pipeline, options] = log[0] ?? [];
    expect(filter).toStrictEqual({
      _id: ID,
      finished: false,
      $or: [{ token: { $lt: 3 } }, { token: 3, holderInstanceId: "instance-1", released: false }],
    });
    expect(options).toStrictEqual({ upsert: true });
    expect((pipeline as { $set: Record<string, unknown> }[])[0]?.$set).toMatchObject({
      yielded: false,
      superseded: false,
      finished: false,
      released: false,
      token: 3,
    });
  });

  it("a document the filter did not match: retired when it is finished, else behind, with the token it holds", async () => {
    const retired = recording({
      updateError: duplicate,
      found: { holderInstanceId: "other", token: 9, released: false, finished: true },
    });
    const behind = recording({
      updateError: duplicate,
      found: { holderInstanceId: "other", token: 9, released: false, finished: false },
    });
    const lost = recording({ updateError: duplicate, found: null });

    expect(await leasesOn(retired.connection).syncClusterLease(LEASE)).toStrictEqual({
      outcome: ClusterLeaseSyncOutcome.Retired,
    });
    expect(await leasesOn(behind.connection).syncClusterLease(LEASE)).toStrictEqual({
      outcome: ClusterLeaseSyncOutcome.Behind,
      rowToken: 9,
    });
    expect(await leasesOn(lost.connection).syncClusterLease(LEASE)).toStrictEqual({
      outcome: ClusterLeaseSyncOutcome.Behind,
      rowToken: 3,
    });
    expect(retired.log[1]).toStrictEqual([
      Collections.ExecutionLeases,
      "findOne",
      { _id: ID },
      { projection: { holderInstanceId: 1, token: 1, released: 1, finished: 1 } },
    ]);
  });

  it("an error that is no duplicate key is the error (an unknown outcome), not read as a document behind", async () => {
    const { connection } = recording({ updateError: new Error("boom") });

    await expect(leasesOn(connection).syncClusterLease(LEASE)).rejects.toBeInstanceOf(
      StoreError.OutcomeUnknown,
    );
  });

  it("a mirrored lease is held, released or retired, with its token and holder", async () => {
    const mirrored = (found: object | null) =>
      leasesOn(recording({ found }).connection).mirroredLeaseOf(TREE);
    const base = { holderInstanceId: "i", token: 2 };

    expect(await mirrored(null)).toBeUndefined();
    expect(await mirrored({ ...base, released: false, finished: false })).toStrictEqual({
      token: 2,
      holderInstanceId: "i",
      state: MirroredLeaseState.Held,
    });
    expect(await mirrored({ ...base, released: true, finished: false })).toMatchObject({
      state: MirroredLeaseState.Released,
    });
    expect(await mirrored({ ...base, released: true, finished: true })).toMatchObject({
      state: MirroredLeaseState.Retired,
    });
  });
});

describe("the seed of a tree's lease document", () => {
  it("is a released, expired lease of nobody at token 0, never over what is there", () => {
    const [stage] = seedStages(TREE);

    expect(stage).toStrictEqual({
      $set: expect.objectContaining({
        holderInstanceId: orSeed("holderInstanceId", literal("")),
        released: orSeed("released", true),
        yielded: orSeed("yielded", false),
        superseded: orSeed("superseded", false),
        finished: orSeed("finished", false),
        expiresAt: orSeed("expiresAt", new Date(0)),
      }),
    });
  });
});

describe("the status history", () => {
  const stored = {
    tenantId: "default",
    threadId: "t-1",
    seq: 2,
    fromStatus: "running",
    toStatus: "paused",
    trigger: "ask",
    at: NOW,
  };

  it("reads a document back with the details it has, and only those", () => {
    expect(transitionOfDocument(stored)).toStrictEqual(stored);
    expect(
      transitionOfDocument({ ...stored, reason: "why", actor: "a", leaseToken: 3 }),
    ).toStrictEqual({ ...stored, reason: "why", actor: "a", leaseToken: 3 });
  });

  it.each([
    ["running after a pause is a resume", "running", ThreadStatus.Paused, StatusTrigger.Resume],
    [
      "running after a dual pause is a resume",
      "running",
      ThreadStatus.DualPaused,
      StatusTrigger.Resume,
    ],
    ["running after finishing is a start", "running", ThreadStatus.Finished, StatusTrigger.Start],
    [
      "a pause after a pause keeps its own trigger",
      "paused",
      ThreadStatus.Paused,
      StatusTrigger.Ask,
    ],
  ])("%s", (_what, recordStatus, lastStatus, trigger) => {
    const last = { toStatus: lastStatus } as never;

    expect(recordTransitionOf(TRANSITION, recordStatus, last, undefined)?.trigger).toBe(trigger);
  });

  it("a command's context overrides the status and the trigger, and brings its details", () => {
    expect(
      recordTransitionOf(TRANSITION, "running", undefined, {
        toStatus: ThreadStatus.Stopping,
        trigger: StatusTrigger.Stop,
        reason: "r",
        actor: "a",
        leaseToken: 1,
      }),
    ).toStrictEqual({
      tenantId: "default",
      threadId: "t-1",
      toStatus: ThreadStatus.Stopping,
      trigger: StatusTrigger.Stop,
      reason: "r",
      actor: "a",
      leaseToken: 1,
    });
    expect(recordTransitionOf(TRANSITION, "running", undefined, undefined)).toStrictEqual({
      tenantId: "default",
      threadId: "t-1",
      toStatus: ThreadStatus.Running,
      trigger: StatusTrigger.Start,
    });
    expect(recordTransitionOf(TRANSITION, "queued", undefined, undefined)).toBeUndefined();
  });
});
