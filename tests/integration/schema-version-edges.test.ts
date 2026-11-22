/**
 * agbossjs/mongodb#103 (acceptance Q: survivors of the migrations shard that its bound read as
 * Timeouts): the version is read from its own document only, and the pauses' channels are filled
 * by the migration to schema 3 — for a database never migrated, at 1 or 2 — and by no other run.
 */
import { MongoClient, type Db } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { Collections } from "../../src/index.js";
import {
  appliedVersionOf,
  migrateSchema,
  SCHEMA_DOCUMENT_ID,
} from "../../src/connection/schema-version.js";
import { dropDatabase } from "../support/database.js";
import { freshDatabaseName, REPLICA_SET_URL } from "../support/server.js";

const made: string[] = [];
const clients: MongoClient[] = [];

/** A database of this file that nothing has migrated. */
function freshDb(): Db {
  const name = freshDatabaseName();
  made.push(name);
  const client = new MongoClient(REPLICA_SET_URL);
  clients.push(client);
  return client.db(name);
}

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  for (const name of made) await dropDatabase(name);
});

/** A pause written before schema 3: no `channel` field, its channel in its record. */
async function pauseWithoutChannel(db: Db): Promise<void> {
  await db.collection<{ _id: string }>(Collections.Pauses).insertOne({
    _id: "default:p1",
    ...{ tenantId: "default", pauseId: "p1", rootExecutionId: "run-1", stepKey: "run-1:a:1" },
    ...{ seq: 1, status: "pending", isSent: true, resolvedAt: null, closing: null },
    record: JSON.stringify({ channel: "refund-channel" }),
  } as never);
}

const channelOf = async (db: Db): Promise<unknown> =>
  (await db.collection(Collections.Pauses).findOne({ pauseId: "p1" }))?.channel;

const setVersion = (db: Db, version: number) =>
  db
    .collection<{ _id: string; version: number }>(Collections.SchemaVersion)
    .insertOne({ _id: SCHEMA_DOCUMENT_ID, version });

describe("the version is the one document's", () => {
  it("another document of the collection is no version: a database that was never migrated says so", async () => {
    const db = freshDb();
    await db
      .collection<{ _id: string; version: number }>(Collections.SchemaVersion)
      .insertOne({ _id: "someone-else", version: 99 });

    expect(await appliedVersionOf(db)).toBeUndefined();
  });

  it("with another document before it, the version is still its own", async () => {
    const db = freshDb();
    const versions = db.collection<{ _id: string; version: number }>(Collections.SchemaVersion);
    await versions.insertOne({ _id: "a-first", version: 99 });
    await versions.insertOne({ _id: SCHEMA_DOCUMENT_ID, version: 2 });

    expect(await appliedVersionOf(db)).toBe(2);
  });
});

describe("the pauses' channels are filled by the migration to schema 3, and by no other", () => {
  it("a database never migrated: its pause gets its channel", async () => {
    const db = freshDb();
    await pauseWithoutChannel(db);

    await migrateSchema(db);

    expect(await channelOf(db)).toBe("refund-channel");
  });

  it.each([1, 2])("a database at version %i: its pause gets its channel", async (version) => {
    const db = freshDb();
    await pauseWithoutChannel(db);
    await setVersion(db, version);

    await migrateSchema(db, { allowLiveLeases: true });

    expect(await channelOf(db)).toBe("refund-channel");
  });

  it.each([3, 4])(
    "a database at version %i has been through it: a pause without a channel is left as it is",
    async (version) => {
      const db = freshDb();
      await pauseWithoutChannel(db);
      await setVersion(db, version);

      await migrateSchema(db, { allowLiveLeases: true });

      expect(await channelOf(db)).toBeUndefined();
    },
  );
});

describe("the version document says when it was written", () => {
  it("a migration leaves `migratedAt`, a date", async () => {
    const db = freshDb();

    await migrateSchema(db);

    const stored = await db
      .collection<{ _id: string; version: number; migratedAt?: Date }>(Collections.SchemaVersion)
      .findOne({ _id: SCHEMA_DOCUMENT_ID });
    expect(stored?.migratedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(stored?.migratedAt?.getTime())).toBe(false);
  });
});
