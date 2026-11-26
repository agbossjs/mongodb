/**
 * agbossjs/mongodb#76 (agbossjs/agboss#1017): an error of a single-command write after the server
 * APPLIED it is `StoreError.OutcomeUnknown` in every MongoDB store — a pause, a fenced effect's
 * sweep, an outbound call, a checkpoint, a record, a queue, a limit, a tree, a mesh request — as it
 * is in the lease store, SQLite and PostgreSQL. The fault is the server's own `failCommand` fail
 * point (the write executes, its reply is a write concern error): the fault-injecting client. Every
 * case checks that the write really was applied (the case's `applied`), so an error taken for "not
 * written" would be a lie; and a read, or a write of a transaction, is never unknown.
 */
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { BudgetScope, ExecutionRecordStatus, StoreClock, StoreTimeSource } from "@agboss/core";
import { A2ATaskState, isStoreOutcomeUnknown, StoreError } from "@agboss/core/stores";
import { StoreOutcomeSource } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { seconds, usd } from "@agboss/core/units";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import {
  MongoBulkWriteError,
  type WriteConcernError,
  type WriteError,
  MongoClient,
  type Collection,
  MongoWriteConcernError,
  type Document,
} from "mongodb";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Collections,
  MongoCheckpointSaver,
  MongoChildExecutionQueueRepository,
  MongoCostLedgerRepository,
  MongoExecutionAuditLogRepository,
  MongoExecutionHistoryRepository,
  MongoExecutionRecordRepository,
  MongoExecutionTreeRepository,
  MongoFencedEffectRepository,
  MongoMeshRequestRepository,
  MongoA2ADirectMessageRepository,
  MongoA2ATaskRepository,
  MongoOutboundCallRepository,
  MongoPausedExecutionRepository,
  MongoRateLimitRepository,
  type MongoConnection,
} from "../../src/index.js";
import { writeErrorOf } from "../../src/connection/outcome.js";
import { TestApplicationContext } from "../support/application-context.js";
import { RecordingLogger } from "../support/recording-logger.js";
import { emptyAll, openConnection, testDatabase } from "../support/database.js";
import { CountingIdGenerator } from "../support/stores.js";
import { pauseOf } from "../support/pauses.js";
import { holdFailPoints } from "../support/failpoint-lock.js";

const APP = "agboss-write-outcome-test";
const database = testDatabase();
holdFailPoints();
const BEFORE = new Date("2030-01-01T00:00:00.000Z");
const WRITES = ["insert", "update", "delete", "findAndModify"];
let started: MongoConnection | undefined;
let adminClient: MongoClient | undefined;

const live = (): MongoConnection => {
  if (started === undefined) throw new Error("the connection is made by the first test's hook");
  return started;
};
const admin = (): MongoClient => {
  if (adminClient === undefined) throw new Error("the client is made by the first test's hook");
  return adminClient;
};

// made in the first test's hook, not in a `beforeAll`: a mutant of the connection that fails here must fail a
// test, which kills it, not the file's setup, which Stryker leaves out of the score (agbossjs/mongodb#103)
beforeEach(async () => {
  // the fail points name this client by its appName: the other files' clients never fail
  started ??= await openConnection(`${database.url()}&appName=${APP}`);
  adminClient ??= new MongoClient(database.url());
  await emptyAll(database.url(), ["write_outcome_probe", "write_outcome_multi"]);
});

afterEach(async () => {
  await admin().db("admin").command({ configureFailPoint: "failCommand", mode: "off" });
});

afterAll(async () => {
  await started?.onDestroy();
  await adminClient?.close();
});

/** The next write of this test's client is APPLIED, then answered with a write concern error (twice: the driver's retry too). */
async function applyThenFail(): Promise<void> {
  await admin()
    .db("admin")
    .command({
      configureFailPoint: "failCommand",
      mode: { times: 2 },
      data: {
        failCommands: WRITES,
        appName: APP,
        writeConcernError: { code: 91, errmsg: "Replication is being shut down" },
      },
    });
}

const count = (collection: string, filter: Document = {}): Promise<number> =>
  live().db.collection(collection).countDocuments(filter);

const clock = new VirtualClock();
const application = new TestApplicationContext("instance-1");
const ids = new CountingIdGenerator();
const storeClock = new StoreClock(StoreTimeSource.Database, { now: () => new Date() });

const trees = (): MongoExecutionTreeRepository => new MongoExecutionTreeRepository(live());
const mesh = (): MongoMeshRequestRepository => new MongoMeshRequestRepository(live());
const limits = (): MongoRateLimitRepository =>
  new MongoRateLimitRepository(live(), clock, application);
const queue = (): MongoChildExecutionQueueRepository =>
  new MongoChildExecutionQueueRepository(live(), clock, application, new RecordingLogger());
const pauses = (): MongoPausedExecutionRepository =>
  new MongoPausedExecutionRepository(live(), clock);
const checkpoints = (): MongoCheckpointSaver => new MongoCheckpointSaver(live());
const calls = (): MongoOutboundCallRepository =>
  new MongoOutboundCallRepository(live(), storeClock);

const TREE = { tenantId: "default", rootExecutionId: "root-1" };
const MESH = { tenantId: "default", peer: "peer-1", idempotencyKey: "key-1" };
const THREAD = { configurable: { thread_id: "thread-76", checkpoint_ns: "" } };
const DIRECT = { tenantId: "default", ownerId: "", messageId: "message-1" };
const CALL_KEY = effectKeyForTesting({
  scopeKey: "default:root-1",
  tenantId: "default",
  leaseExecutionId: "root-1",
  token: 1,
  idempotencyKey: "root-1:charge-action:1",
  name: "charge",
});

/** One single-command write: what runs, and what the server holds after it applied. */
interface WriteCase {
  readonly name: string;
  readonly setup?: () => Promise<unknown>;
  readonly write: () => Promise<unknown>;
  /** Whether the write's effect is on the server. */
  readonly applied?: () => Promise<boolean>;
}

/** The claim of a mesh request by an attempt (#1319c). */
const claim = (attemptId: string, createdAt: string) => ({
  tool: "charge",
  requestHash: `sha256:${"ab".repeat(32)}`,
  createdAt,
  expiresAt: "2026-02-05T09:00:00.000Z",
  attemptId,
  lockedUntil: "2026-01-05T09:00:30.000Z",
});

const CASES: readonly WriteCase[] = [
  {
    name: "mesh request: saveIfAbsent",
    write: () => mesh().saveIfAbsent({ ...MESH, ...claim("a-1", BEFORE.toISOString()) }),
    applied: async () => (await count(Collections.MeshRequests)) === 1,
  },
  {
    name: "mesh request: saveResponse",
    setup: () => mesh().saveIfAbsent({ ...MESH, ...claim("a-1", BEFORE.toISOString()) }),
    write: () => mesh().saveResponse(MESH, "a-1", { ok: true }),
    applied: async () => (await count(Collections.MeshRequests, { response: { $ne: null } })) === 1,
  },
  {
    name: "mesh request: deleteByKey",
    setup: () => mesh().saveIfAbsent({ ...MESH, ...claim("a-1", BEFORE.toISOString()) }),
    write: () => mesh().deleteByKey(MESH, "a-1"),
    applied: async () => (await count(Collections.MeshRequests)) === 0,
  },
  {
    name: "mesh request: deleteExpired",
    setup: () => mesh().saveIfAbsent({ ...MESH, ...claim("a-1", "2020-01-01T00:00:00.000Z") }),
    write: () => mesh().deleteExpired(BEFORE),
    applied: async () => (await count(Collections.MeshRequests)) === 0,
  },
  {
    name: "execution tree: saveIfAbsentInTree",
    write: () => trees().saveIfAbsentInTree(TREE, "k1", { v: 1 }),
    applied: async () => (await count(Collections.ExecutionTreeKeys)) === 1,
  },
  {
    name: "execution tree: deleteAllInTree",
    setup: () => trees().saveIfAbsentInTree(TREE, "k1", { v: 1 }),
    write: () => trees().deleteAllInTree(TREE),
    applied: async () => (await count(Collections.ExecutionTreeKeys)) === 0,
  },
  {
    name: "rate limit: pauseUntil",
    write: () => limits().pauseUntil("provider-1", BEFORE),
    applied: async () => (await count(Collections.RateLimitPauses)) === 1,
  },
  {
    name: "rate limit: acquire",
    write: () => limits().acquire("provider-1", 1, seconds(60)),
    applied: async () => (await count(Collections.RateLimitSlots)) === 1,
  },
  {
    name: "rate limit: clearWindow",
    setup: () => limits().addToWindow("provider-1", 1, seconds(60)),
    write: () => limits().clearWindow("provider-1"),
    applied: async () => (await count(Collections.RateLimitWindows)) === 0,
  },
  {
    name: "child queue: saveIfAbsent",
    write: () =>
      queue().saveIfAbsent({
        ...{ tenantId: "default", executionId: "child-1", rootExecutionId: "root-1" },
        ...{ parentExecutionId: "root-1", rootWorkflow: "w", workflow: "w", depth: 1, run: "{}" },
        ...{ status: ExecutionRecordStatus.Queued, queuedAt: BEFORE },
      }),
    applied: async () => (await count(Collections.ChildExecutionQueue)) === 1,
  },
  {
    name: "child queue: deleteAllByTenantIdAndRootExecutionId",
    write: () => queue().deleteAllByTenantIdAndRootExecutionId("default", "root-1"),
  },
  {
    name: "checkpoint: put",
    write: () =>
      checkpoints().put(
        THREAD,
        { ...emptyCheckpoint(), id: "1ef-76" },
        { source: "loop", step: 1, parents: {} },
        {},
      ),
    applied: async () => (await count(Collections.Checkpoints)) === 1,
  },
  {
    name: "checkpoint: deleteThread",
    write: () => checkpoints().deleteThread("thread-76"),
  },
  {
    name: "paused execution: deleteByTenantIdAndThreadId",
    write: () => pauses().deleteByTenantIdAndThreadId("default", "thread-1"),
  },
  {
    name: "paused execution: deleteByTenantIdAndThreadIdAndRunId",
    write: () => pauses().deleteByTenantIdAndThreadIdAndRunId("default", "thread-1", "run-1"),
  },
  {
    name: "pause: findOrCreateByStepKey (its sequence, its upsert)",
    write: () => pauses().findOrCreateByStepKey(pauseOf("p1")),
    applied: async () => (await count(Collections.Sequences)) === 1,
  },
  {
    name: "pause: markTakenByTenantIdAndPauseId",
    write: () => pauses().markTakenByTenantIdAndPauseId("default", "p1"),
  },
  {
    name: "outbound call: saveIfAbsent (its sequence is the first write)",
    write: () =>
      calls().saveIfAbsent(CALL_KEY, {
        ...{ rootExecutionId: "root-1", executionId: "root-1", workflow: "w", target: "payments" },
        ...{ operation: "charge", idempotencyKey: "root-1:charge-action:1", request: "{}" },
        ...{ attempt: 1, attemptOwner: "instance-1", step: { nodeId: "n", visitNumber: 1 } },
      }),
    applied: async () => (await count(Collections.Sequences)) === 1,
  },
  {
    name: "outbound call: deleteExpired",
    write: () => calls().deleteExpired(BEFORE),
  },
  {
    name: "fenced effect: deleteExpired",
    write: () => new MongoFencedEffectRepository(live(), storeClock).deleteExpired(BEFORE),
  },
  {
    name: "execution record: createThread",
    write: () =>
      new MongoExecutionRecordRepository(live(), clock, application, ids).createThread({
        workflow: "w",
        tenantId: "default",
        threadId: "thread-76",
      }),
    applied: async () => (await count(Collections.Threads)) === 1,
  },
  {
    name: "cost ledger: saveLimit",
    write: () =>
      new MongoCostLedgerRepository(live()).saveLimit(
        { budget: "b", scope: BudgetScope.Tenant, key: "default" },
        { maxSpend: usd(5) },
      ),
    applied: async () => (await count(Collections.CostMaxSpend)) === 1,
  },
  {
    name: "audit log: deleteExpired",
    write: () =>
      new MongoExecutionAuditLogRepository(live()).deleteExpired(BEFORE, () =>
        Promise.resolve(true),
      ),
  },
  {
    name: "history: deleteExpired",
    write: () => new MongoExecutionHistoryRepository(live()).deleteExpired(BEFORE),
  },
  {
    name: "a2a task: deleteExpired (a finished task is due: the sweep's first delete)",
    setup: async () => {
      const task = {
        ...{ endpoint: "orders", tenantId: "default", taskId: "t-1", ownerId: "alice" },
        contextId: "ctx-1",
        ...{ skill: "order-workflow-start", acceptedAt: new Date("2026-01-05T09:00:00.000Z") },
        ...{ messageId: "m-1", requestHash: "h-1" },
      };
      const tasks = new MongoA2ATaskRepository(live());
      await tasks.saveIfAbsent({
        ...task,
        status: { state: A2ATaskState.Submitted, pendingPauses: [] },
      });
      await tasks.compareAndSetStatus(
        task,
        1,
        { state: A2ATaskState.Completed, pendingPauses: [] },
        new Date("2026-01-05T09:01:00.000Z"),
      );
    },
    write: () => new MongoA2ATaskRepository(live()).deleteExpired(new Map([["orders", BEFORE]])),
    applied: async () => (await count(Collections.A2ATasks)) === 0,
  },
  {
    name: "a2a direct message: deleteIfInFlight",
    write: () => new MongoA2ADirectMessageRepository(live()).deleteIfInFlight(DIRECT, "a-1"),
  },
];

describe("agbossjs/mongodb#76: a single-command write answered with an error after it was applied is unknown", () => {
  it.each(CASES.map((one) => [one.name, one] as const))("%s", async (_name, one) => {
    await one.setup?.();
    await applyThenFail();

    const failure: unknown = await one.write().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StoreError.OutcomeUnknown);
    expect(failure).toMatchObject({
      code: "store.outcome-unknown",
      source: StoreOutcomeSource.Transport,
    });
    expect((failure as StoreError.OutcomeUnknown).cause).toBeInstanceOf(MongoWriteConcernError);
    if (one.applied !== undefined) {
      await admin().db("admin").command({ configureFailPoint: "failCommand", mode: "off" });
      expect(await one.applied()).toBe(true);
    }
  });
});

describe("agbossjs/mongodb#76: the seam reads every write method of a collection, and only a write outside a transaction", () => {
  const raw = (): Collection<{ _id: string; x?: number }> =>
    live().db.collection("write_outcome_probe");

  it.each([
    ["insertOne", () => raw().insertOne({ _id: "a" })],
    ["insertMany", () => raw().insertMany([{ _id: "a" }, { _id: "b" }])],
    ["updateOne", () => raw().updateOne({ _id: "a" }, { $set: { x: 1 } }, { upsert: true })],
    ["updateMany", () => raw().updateMany({}, { $set: { x: 1 } })],
    ["replaceOne", () => raw().replaceOne({ _id: "a" }, { x: 1 }, { upsert: true })],
    ["deleteOne", () => raw().deleteOne({ _id: "a" })],
    ["deleteMany", () => raw().deleteMany({})],
    [
      "findOneAndUpdate",
      () => raw().findOneAndUpdate({ _id: "a" }, { $set: { x: 1 } }, { upsert: true }),
    ],
    ["findOneAndReplace", () => raw().findOneAndReplace({ _id: "a" }, { x: 1 }, { upsert: true })],
    ["findOneAndDelete", () => raw().findOneAndDelete({ _id: "a" })],
    [
      "bulkWrite (the driver wraps its error)",
      () => raw().bulkWrite([{ insertOne: { document: { _id: "a" } } }], { ordered: false }),
    ],
  ] as const)("%s", async (_name, write) => {
    await applyThenFail();

    const failure: unknown = await write().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StoreError.OutcomeUnknown);
  });

  it("a duplicate key of a bulk write is the server's answer for one operation: known, as it is", async () => {
    await raw().insertOne({ _id: "dup" });

    const failure: unknown = await raw()
      .bulkWrite([{ insertOne: { document: { _id: "dup" } } }])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MongoBulkWriteError);
    expect(isStoreOutcomeUnknown(failure)).toBe(false);
  });

  it("a read is never unknown", async () => {
    await applyThenFail();

    expect(await raw().countDocuments({})).toBe(0);
  });

  it("a write of a transaction is left as it is: a cut connection is the driver's to retry, the commit decides", async () => {
    await admin()
      .db("admin")
      .command({
        configureFailPoint: "failCommand",
        mode: { times: 1 },
        data: { failCommands: ["insert"], appName: APP, closeConnection: true },
      });
    let runs = 0;

    await live().inTransaction(({ db, session }) => {
      runs += 1;
      return db
        .collection<{ _id: string }>("write_outcome_probe")
        .insertOne({ _id: "tx" }, { session });
    });

    // the first attempt's cut connection was a transient transaction error, not an unknown outcome
    expect(runs).toBe(2);
    expect(await raw().countDocuments({ _id: "tx" })).toBe(1);
  });

  it("updateMany outside a transaction that fails on its second document (a duplicate key) left the first written: unknown", async () => {
    const many = live().db.collection<{ _id: number; u?: number }>("write_outcome_multi");
    await many.createIndex({ u: 1 }, { unique: true, sparse: true }, {});
    await many.insertMany([{ _id: 1 }, { _id: 2 }]);

    const failure: unknown = await many
      .updateMany({}, { $set: { u: 7 } })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StoreError.OutcomeUnknown);
    expect(failure).toMatchObject({ cause: { code: 11000 } });
    expect(await many.countDocuments({ u: 7 })).toBe(1);
  });

  describe("a bulk write's error that also carries a write concern error", () => {
    const duplicate = async (): Promise<MongoBulkWriteError> => {
      // a result of a bulk that did nothing: no operation succeeded
      const nothing = await raw().bulkWrite([{ deleteOne: { filter: { _id: "none" } } }]);
      const op = { _id: "a" };
      const failed: WriteError = {
        err: { index: 0, code: 11000, errmsg: "E11000", op, errInfo: {} },
        code: 11000,
        index: 0,
        errmsg: "E11000",
        errInfo: {},
        getOperation: () => op,
        toJSON: () => ({ code: 11000, index: 0, errmsg: "E11000", op }),
        toString: () => "WriteError(E11000)",
      };
      return new MongoBulkWriteError(
        { message: "E11000", code: 11000, writeErrors: [failed] },
        nothing,
      );
    };

    it("control: every operation refused by the server, none succeeded, is known", async () => {
      const error = await duplicate();

      expect(writeErrorOf("coll.bulkWrite", error)).toBe(error);
    });

    it("with its write concern error (the batch may have been applied) it is unknown", async () => {
      const error = await duplicate();
      const concern: WriteConcernError = {
        code: 91,
        errmsg: "shutting down",
        errInfo: undefined,
        toJSON: () => ({ code: 91, errmsg: "shutting down" }),
        toString: () => "WriteConcernError(shutting down)",
      };
      error.err = concern;

      expect(writeErrorOf("coll.bulkWrite", error)).toBeInstanceOf(StoreError.OutcomeUnknown);
    });
  });

  it("a write of a transaction whose failure ends the transaction is still left to the driver (the state is read before the call)", async () => {
    await admin()
      .db("admin")
      .command({
        configureFailPoint: "failCommand",
        mode: { times: 1 },
        data: {
          failCommands: ["insert"],
          appName: APP,
          errorCode: 11602,
          errorLabels: ["TransientTransactionError"],
        },
      });
    let runs = 0;

    await live().inTransaction(({ db, session }) => {
      runs += 1;
      return db
        .collection<{ _id: string }>("write_outcome_probe")
        .insertOne({ _id: "t2" }, { session });
    });

    expect(runs).toBe(2);
    expect(await raw().countDocuments({ _id: "t2" })).toBe(1);
  });
});
