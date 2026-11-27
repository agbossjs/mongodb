/**
 * agbossjs/agboss#527 — what the stores do when MongoDB answers a write with an error, forced by
 * the server's own `failCommand` fail point (`enableTestCommands=1`, as the test replica set and
 * CI's run): a transient transaction error, a commit whose outcome is unknown, a write applied but
 * its reply lost. Each is retried by the driver, and each must leave exactly one effect.
 */
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { IdempotencyRunStatus, StoreClock, StoreTimeSource } from "@agboss/core";
import { type EffectKey, StoreError } from "@agboss/core/stores";
import { StoreOutcomeSource } from "@agboss/core/stores";
import { minutes } from "@agboss/core/units";
import { MongoClient, type Document } from "mongodb";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  MongoExecutionLeaseRepository,
  MongoFencedEffectRepository,
  MongoOutboundCallRepository,
  type MongoConnection,
} from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { openConnection, testDatabase } from "../support/database.js";
import { holdFailPoints } from "../support/failpoint-lock.js";

const APP = "agboss-retries-test";
const database = testDatabase();
holdFailPoints();
let connection: MongoConnection;
let admin: MongoClient;

/** The server's own clock, as production stores read it. */
const serverClock = (): StoreClock =>
  new StoreClock(StoreTimeSource.Database, { now: () => new Date() });

beforeAll(async () => {
  // the fail points name this client by its appName: the other files' clients never fail
  connection = await openConnection(`${database.url()}&appName=${APP}`);
  admin = new MongoClient(database.url());
});

afterEach(async () => {
  await admin.db("admin").command({ configureFailPoint: "failCommand", mode: "off" });
  // a commit whose connection was cut leaves its transaction open on the server until its lifetime
  // limit, and the database's drop waits for it (agbossjs/agboss#985): ended here
  const open = await admin
    .db("admin")
    .aggregate([
      { $currentOp: { allUsers: true, idleSessions: true } },
      { $match: { appName: APP, transaction: { $exists: true } } },
      { $project: { lsid: 1 } },
    ])
    .toArray();
  if (open.length > 0)
    await admin
      .db("admin")
      .command({ killSessions: open.map((operation) => operation.lsid as Document) });
});

afterAll(async () => {
  await connection.onDestroy();
  await admin.close();
});

/** Makes the next `times` of `commands` of this test's client fail as `data` says. */
async function failNext(commands: readonly string[], data: Document, times = 1): Promise<void> {
  await admin.db("admin").command({
    configureFailPoint: "failCommand",
    mode: { times },
    data: { failCommands: commands, appName: APP, ...data },
  });
}

const leasesOf = (instanceId: string): MongoExecutionLeaseRepository =>
  new MongoExecutionLeaseRepository(
    connection,
    serverClock(),
    new TestApplicationContext(instanceId),
  );

/** A fenced-effect key under `lease`'s token. */
const keyOf = (rootExecutionId: string, token: number): EffectKey =>
  effectKeyForTesting({
    scopeKey: `default:${encodeURIComponent(rootExecutionId)}`,
    tenantId: "default",
    leaseExecutionId: rootExecutionId,
    token,
    idempotencyKey: `${rootExecutionId}:charge-action:1`,
    name: "charge",
  });

/** The business documents of `root`'s charge. */
const chargesOf = (root: string): Promise<number> =>
  connection.db.collection("retry_charges").countDocuments({ root });

describe("a fenced effect's transaction on an error the driver retries", () => {
  it("a transient error (a write conflict) runs the work again in a new transaction: one charge, Ran", async () => {
    const lease = await leasesOf("instance-1").acquire("default", "transient-1", minutes(1));
    const effects = new MongoFencedEffectRepository(connection, serverClock());
    await failNext(["insert"], { errorCode: 112, errorLabels: ["TransientTransactionError"] });
    let runs = 0;

    const outcome = await effects.runOnce(keyOf("transient-1", lease?.token ?? 0), async () => {
      const { db, session } = connection.requireTransaction();
      runs += 1;
      await db.collection("retry_charges").insertOne({ root: "transient-1" }, { session });
      return { receipt: "r1" };
    });

    expect(outcome).toMatchObject({ status: IdempotencyRunStatus.Ran, result: { receipt: "r1" } });
    // the first attempt was aborted: its insert never committed
    expect(runs).toBe(2);
    expect(await chargesOf("transient-1")).toBe(1);
  });

  it("a commit applied but answered with an error (unknown outcome) is committed again, never run again: one charge", async () => {
    const lease = await leasesOf("instance-1").acquire("default", "unknown-1", minutes(1));
    const effects = new MongoFencedEffectRepository(connection, serverClock());
    await failNext(["commitTransaction"], {
      writeConcernError: { code: 91, errmsg: "Replication is being shut down" },
    });
    let runs = 0;

    const outcome = await effects.runOnce(keyOf("unknown-1", lease?.token ?? 0), async () => {
      const { db, session } = connection.requireTransaction();
      runs += 1;
      await db.collection("retry_charges").insertOne({ root: "unknown-1" }, { session });
      return { receipt: "r1" };
    });

    expect(outcome.status).toBe(IdempotencyRunStatus.Ran);
    expect(runs).toBe(1);
    expect(await chargesOf("unknown-1")).toBe(1);
  });

  it("a commit that keeps failing rejects; the next call replays what the first one committed", async () => {
    const lease = await leasesOf("instance-1").acquire("default", "unknown-2", minutes(1));
    const key = keyOf("unknown-2", lease?.token ?? 0);
    const effects = new MongoFencedEffectRepository(connection, serverClock());
    // applied every time, answered with a non-retryable error: the caller cannot tell it committed
    await failNext(["commitTransaction"], {
      writeConcernError: { code: 100, errmsg: "unsatisfiable" },
    });
    const charge = async (): Promise<{
      receipt: string;
    }> => {
      const { db, session } = connection.requireTransaction();
      await db.collection("retry_charges").insertOne({ root: "unknown-2" }, { session });
      return { receipt: "r1" };
    };

    await expect(effects.runOnce(key, charge)).rejects.toThrow();
    const again = await effects.runOnce(key, charge);

    expect(again).toMatchObject({
      status: IdempotencyRunStatus.Replayed,
      result: { receipt: "r1" },
    });
    expect(await chargesOf("unknown-2")).toBe(1);
  });
});

describe("agbossjs/agboss#1017: what the driver's retry could not resolve is unknown", () => {
  it("a commit whose retry fails too is StoreError.OutcomeUnknown (Transport), the work run once; the next call replays the charge", async () => {
    const lease = await leasesOf("instance-1").acquire("default", "unknown-3", minutes(1));
    const key = keyOf("unknown-3", lease?.token ?? 0);
    const effects = new MongoFencedEffectRepository(connection, serverClock());
    // applied both times (the commit and its retry), answered with a retryable error both times
    await failNext(
      ["commitTransaction"],
      { writeConcernError: { code: 91, errmsg: "Replication is being shut down" } },
      2,
    );
    let runs = 0;
    const charge = async (): Promise<{
      receipt: string;
    }> => {
      const { db, session } = connection.requireTransaction();
      runs += 1;
      await db.collection("retry_charges").insertOne({ root: "unknown-3" }, { session });
      return { receipt: "r1" };
    };

    const failure: unknown = await effects.runOnce(key, charge).catch((error: unknown) => error);
    const again = await effects.runOnce(key, charge);

    expect(failure).toBeInstanceOf(StoreError.OutcomeUnknown);
    expect(failure).toMatchObject({
      code: "store.outcome-unknown",
      source: StoreOutcomeSource.Transport,
    });
    expect(runs).toBe(1);
    expect(again).toMatchObject({
      status: IdempotencyRunStatus.Replayed,
      result: { receipt: "r1" },
    });
    expect(await chargesOf("unknown-3")).toBe(1);
  });

  it("a commit whose connection is cut twice (no answer at all) is StoreError.OutcomeUnknown too", async () => {
    const lease = await leasesOf("instance-1").acquire("default", "unknown-4", minutes(1));
    const effects = new MongoFencedEffectRepository(connection, serverClock());
    await failNext(["commitTransaction"], { closeConnection: true }, 2);

    const failure: unknown = await effects
      .runOnce(keyOf("unknown-4", lease?.token ?? 0), async () => {
        const { db, session } = connection.requireTransaction();
        await db.collection("retry_charges").insertOne({ root: "unknown-4" }, { session });
        return { receipt: "r1" };
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StoreError.OutcomeUnknown);
  });

  it("an error the work throws, or a write conflict, is no unknown outcome: it is rethrown as it is, or the work runs again", async () => {
    const lease = await leasesOf("instance-1").acquire("default", "known-1", minutes(1));
    const effects = new MongoFencedEffectRepository(connection, serverClock());

    const failure: unknown = await effects
      .runOnce(keyOf("known-1", lease?.token ?? 0), () => Promise.reject(new TypeError("no")))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TypeError);
  });

  it("a single-command write whose retry fails too is StoreError.OutcomeUnknown: acquire (a cancel is a transaction since #1341d: the driver retries it as a whole)", async () => {
    const leases = leasesOf("instance-1");
    await failNext(["findAndModify"], { closeConnection: true }, 2);

    const acquired: unknown = await leases
      .acquire("default", "unknown-5", minutes(1))
      .catch((error: unknown) => error);

    expect(acquired).toBeInstanceOf(StoreError.OutcomeUnknown);
  });
});

describe("a single-document write whose reply is lost is retried exactly once", () => {
  it("acquire: applied, its reply an error — the retry answers the same take, its epoch counted once", async () => {
    const leases = leasesOf("instance-1");
    const first = await leases.acquire("default", "lost-1", minutes(1));
    if (first !== undefined) await leases.release(first);
    // the next take of the released lease is applied, then answered with an error
    await failNext(["findAndModify"], { writeConcernError: { code: 91, errmsg: "shutting down" } });
    const lease = await leasesOf("instance-1").acquire("default", "lost-1", minutes(1));
    const stored = await connection.db
      .collection<{ _id: string; token: number }>("agboss_execution_leases")
      .findOne({ _id: JSON.stringify(["default", "lost-1"]) });

    expect(lease?.token).toBe(2);
    expect(stored?.token).toBe(2);
    expect(await leasesOf("instance-2").acquire("default", "lost-1", minutes(1))).toBeUndefined();
  });

  it("acquire: its connection cut before the command — retried on a new one, one lease", async () => {
    await failNext(["findAndModify"], { closeConnection: true });
    const lease = await leasesOf("instance-1").acquire("default", "cut-1", minutes(1));

    expect(lease?.token).toBe(1);
    expect(await leasesOf("instance-2").acquire("default", "cut-1", minutes(1))).toBeUndefined();
  });

  it("claimExecutionId: applied, its reply an error — the retry is told true, the id kept once", async () => {
    await failNext(["insert"], { writeConcernError: { code: 91, errmsg: "shutting down" } });
    const leases = leasesOf("instance-1");

    expect(await leases.claimExecutionId({ executionId: "kept-1", tenantId: "default" })).toBe(
      true,
    );
    expect(await leases.claimExecutionId({ executionId: "kept-1", tenantId: "default" })).toBe(
      false,
    );
  });
});

describe("an outbound call's intent on a transient error", () => {
  it("saveIfAbsent conflicting once is run again: recorded once, true", async () => {
    const lease = await leasesOf("instance-1").acquire("default", "call-1", minutes(1));
    const calls = new MongoOutboundCallRepository(connection, serverClock());
    const key = keyOf("call-1", lease?.token ?? 0);
    await failNext(["update"], { errorCode: 112, errorLabels: ["TransientTransactionError"] });

    const saved = await calls.saveIfAbsent(key, {
      rootExecutionId: "call-1",
      executionId: "call-1",
      workflow: "charge-workflow",
      target: "payments",
      operation: "charge",
      idempotencyKey: `${key.idempotencyKey}:charge`,
      request: "{}",
      attempt: 1,
      attemptOwner: "owner-1",
      step: { nodeId: "charge-action", visitNumber: 1 },
    });

    expect(saved).toBe(true);
    expect(await connection.db.collection("agboss_outbound_calls").countDocuments()).toBe(1);
  });
});
