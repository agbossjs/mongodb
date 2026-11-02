/**
 * `MongoConnection` against a real MongoDB (CI: `mongo:7`, a single-node replica set `rs0`, and a
 * standalone `mongo:7`); without `AGBOSS_MONGODB_TEST_URL` / `AGBOSS_MONGODB_STANDALONE_TEST_URL`
 * the run fails (the global setup says how to start them).
 */
import type { Collection } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MongoConnection,
  MongoReplicaSetRequiredError,
  MongoTopology,
  TransactionReadConcern,
} from "../../src/index.js";
import { freshDatabaseName, REPLICA_SET_URL, STANDALONE_URL } from "../support/server.js";

interface Payment {
  readonly _id: string;
  readonly amount: number;
}

describe("MongoConnection on a replica set", () => {
  // built in beforeAll: a skipped describe still runs its body, and an empty URL is refused
  let connection: MongoConnection;
  let payments: Collection<Payment>;

  beforeAll(async () => {
    connection = new MongoConnection({ url: REPLICA_SET_URL, database: freshDatabaseName() });
    payments = connection.db.collection<Payment>("payments");
    await connection.onInit();
    await connection.db.createCollection("payments");
  });

  afterAll(async () => {
    await connection.db.dropDatabase();
    await connection.onDestroy();
  });

  it("the start check passes and names the deployment a replica set", async () => {
    expect(await connection.deployment()).toBe(MongoTopology.ReplicaSet);
  });

  it("ping answers", async () => {
    await expect(connection.ping()).resolves.toBeUndefined();
  });

  it("a write is acknowledged by a majority on the journal", async () => {
    const result = await payments.insertOne({ _id: "acknowledged", amount: 1 });

    expect(result.acknowledged).toBe(true);
    expect(payments.writeConcern?.w).toBe("majority");
  });

  it("a transaction's writes commit together", async () => {
    const done = await connection.inTransaction(async ({ session }) => {
      await payments.insertOne({ _id: "t1-a", amount: 10 }, { session });
      await payments.insertOne({ _id: "t1-b", amount: 20 }, { session });
      return "committed";
    });

    expect(done).toBe("committed");
    expect(await payments.countDocuments({ _id: { $in: ["t1-a", "t1-b"] } })).toBe(2);
  });

  it("a transaction whose work throws leaves nothing behind", async () => {
    const failure = connection.inTransaction(async ({ session }) => {
      await payments.insertOne({ _id: "t2-a", amount: 10 }, { session });
      throw new Error("the business write failed");
    });

    await expect(failure).rejects.toThrow("the business write failed");
    expect(await payments.countDocuments({ _id: "t2-a" })).toBe(0);
  });

  it("a snapshot transaction does not see a write committed after its first read", async () => {
    const seen = await connection.inTransaction(async ({ session }) => {
      const before = await payments.countDocuments({ amount: 99 }, { session });
      await payments.insertOne({ _id: `outside-${String(before)}`, amount: 99 });
      const after = await payments.countDocuments({ amount: 99 }, { session });
      return { before, after };
    });

    expect(connection.transactionOptions.readConcern).toEqual({
      level: TransactionReadConcern.Snapshot,
    });
    expect(seen.after).toBe(seen.before);
    expect(await payments.countDocuments({ amount: 99 })).toBe(seen.before + 1);
  });
});

describe("MongoConnection on a standalone mongod", () => {
  it("the start check refuses it with MongoReplicaSetRequiredError", async () => {
    const connection = new MongoConnection({ url: STANDALONE_URL });
    try {
      await expect(connection.onInit()).rejects.toThrow(MongoReplicaSetRequiredError);
      await expect(connection.deployment()).rejects.toThrow(/standalone mongod/);
    } finally {
      await connection.onDestroy();
    }
  });
});
