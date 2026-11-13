/**
 * agbossjs/agboss#938 AC2 — a database at schema version 1 migrates to 2 and keeps its pauses: the
 * indexes and the notices' collection are made, a pause written by version 1 (no `channel`, no
 * deadline fields) gets its `channel` from its record and still reads back, a second migrate
 * changes nothing, and two concurrent ones end in one schema.
 */
import { PauseAnswerer, PauseKind, PauseStatus, type PauseRecord } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { MongoClient, type Db } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { Collections, migrateMongodb, MongoPausedExecutionRepository } from "../../src/index.js";
import { idOf } from "../../src/stores/keys.js";
import { dropDatabase, urlOnDatabase } from "../support/database.js";
import { freshDatabaseName, REPLICA_SET_URL } from "../support/server.js";
import { connectionTo } from "../support/stores.js";

const made: string[] = [];
afterAll(async () => {
  for (const database of made) await dropDatabase(database);
});

const PAUSE: PauseRecord = {
  pauseId: "p1",
  tenantId: "default",
  threadId: "thread-1",
  rootExecutionId: "run-1",
  executionId: "run-1",
  workflow: "order-workflow",
  stepKey: "run-1:clerk:1",
  nodeId: "clerk-agent",
  visitNumber: 1,
  itemIndex: undefined,
  copyNumber: 1,
  kind: PauseKind.Approval,
  step: "clerk-agent",
  channel: "refund-approval-channel",
  answerer: PauseAnswerer.Channel,
  ask: { callId: "call-1", tool: "charge", arguments: {}, summary: "charge" },
  status: PauseStatus.Pending,
  isSent: true,
  askedAt: "2026-01-05T09:00:00.000Z",
};

/** A database at schema version 1: migrated, then v2's collection and indexes dropped, version set back, one v1 pause kept. */
async function databaseAtVersion1(): Promise<string> {
  const database = freshDatabaseName();
  made.push(database);
  await migrateMongodb({ url: REPLICA_SET_URL, database });
  const client = new MongoClient(REPLICA_SET_URL);
  try {
    const db = client.db(database);
    await db.collection(Collections.PauseNotices).drop();
    const pauses = db.collection<{ _id: string; [field: string]: unknown }>(Collections.Pauses);
    for (const name of ["pending_by_expiry", "pending_by_remind", "by_tenant", "open"])
      await pauses.dropIndex(name);
    await db
      .collection<{ _id: string }>(Collections.SchemaVersion)
      .updateOne({ _id: "agboss" }, { $set: { version: 1 } });
    await pauses.insertOne({
      _id: idOf("default", "p1"),
      tenantId: "default",
      pauseId: "p1",
      rootExecutionId: "run-1",
      stepKey: PAUSE.stepKey,
      seq: 1,
      status: PauseStatus.Pending,
      isSent: true,
      resolvedAt: null,
      record: JSON.stringify(PAUSE),
      closing: null,
    });
  } finally {
    await client.close();
  }
  return database;
}

const indexNamesOf = async (db: Db, collection: string): Promise<string[]> =>
  (await db.collection(collection).indexes()).map((index) => index.name ?? "");

async function onDatabase<T>(database: string, work: (db: Db) => Promise<T>): Promise<T> {
  const client = new MongoClient(REPLICA_SET_URL);
  try {
    return await work(client.db(database));
  } finally {
    await client.close();
  }
}

describe("agbossjs/agboss#938 AC2: schema version 1 to 2", () => {
  it("AC2: version 1 → 2 keeps pauses, fills channel, makes the indexes, twice is a no-op", async () => {
    const database = await databaseAtVersion1();

    const first = await migrateMongodb({ url: REPLICA_SET_URL, database });
    const second = await migrateMongodb({ url: REPLICA_SET_URL, database });

    expect(first).toEqual({
      database,
      applied: [{ version: 2, name: "pause-deadlines-and-notices" }],
      version: 2,
    });
    expect(second).toEqual({ database, applied: [], version: 2 });
    await onDatabase(database, async (db) => {
      expect(await indexNamesOf(db, Collections.Pauses)).toEqual(
        expect.arrayContaining(["pending_by_expiry", "pending_by_remind", "by_tenant", "open"]),
      );
      expect(await indexNamesOf(db, Collections.PauseNotices)).toEqual(
        expect.arrayContaining(["due", "stale", "by_pause"]),
      );
      const partial = (await db.collection(Collections.Pauses).indexes()).find(
        (index) => index.name === "pending_by_expiry",
      );
      expect(partial?.partialFilterExpression).toEqual({
        status: "pending",
        expiresAt: { $type: "date" },
      });
      expect(await db.collection(Collections.Pauses).findOne({ pauseId: "p1" })).toMatchObject({
        channel: "refund-approval-channel",
      });
    });
    const pauses = new MongoPausedExecutionRepository(
      connectionTo(urlOnDatabase(REPLICA_SET_URL, database)),
      new VirtualClock(),
    );
    expect(await pauses.findByTenantIdAndPauseId("default", "p1")).toEqual(PAUSE);
    const page = await pauses.findPageByTenantId(
      "default",
      { statuses: [PauseStatus.Pending], channel: "refund-approval-channel" },
      10,
    );
    expect(page.pauses.map((pause) => pause.pauseId)).toEqual(["p1"]);
  });

  it("AC2: two concurrent migrations of a version 1 database end in one schema", async () => {
    const database = await databaseAtVersion1();

    const reports = await Promise.all(
      [1, 2].map(() => migrateMongodb({ url: REPLICA_SET_URL, database })),
    );

    expect(reports.every((report) => report.version === 2)).toBe(true);
    await onDatabase(database, async (db) => {
      expect(
        await db.collection(Collections.Pauses).countDocuments({ channel: { $exists: false } }),
      ).toBe(0);
    });
  });
});
