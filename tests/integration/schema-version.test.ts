/**
 * agbossjs/agboss#891 AC1 — the MongoDB schema is versioned (`agboss_schema`) and migrated
 * explicitly: `migrateMongodb` (and the bin, `bin-migrate.test.ts`) make it and write the version;
 * a start with `SchemaSetup.Check` (the default) refuses a database never migrated, an older one, a
 * newer one, or one a stores' collection was dropped from — and creates nothing; one with
 * `SchemaSetup.MigrateOnStart` migrates first.
 */
import { SchemaSetup } from "@agboss/core/stores";
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import {
  Collections,
  migrateMongodb,
  MongoConnection,
  MongoSchemaMissingError,
  MongoSchemaTooNewError,
} from "../../src/index.js";
import { dropDatabase } from "../support/database.js";
import { freshDatabaseName, REPLICA_SET_URL } from "../support/server.js";

const made: string[] = [];

afterAll(async () => {
  for (const database of made) await dropDatabase(database);
});

/** A new database of this file: its name. */
const freshDatabase = (): string => {
  const database = freshDatabaseName();
  made.push(database);
  return database;
};

/** `work` on a plain client of `database` (no schema check, no enforced concerns). */
async function onDatabase<T>(
  database: string,
  work: (db: ReturnType<MongoClient["db"]>) => Promise<T>,
): Promise<T> {
  const client = new MongoClient(REPLICA_SET_URL);
  try {
    return await work(client.db(database));
  } finally {
    await client.close();
  }
}

/** The start of a connection on `database` with `schemaSetup`; closed after, its outcome kept. */
async function startOn(database: string, schemaSetup?: SchemaSetup): Promise<void> {
  const connection = new MongoConnection({ url: REPLICA_SET_URL, database, schemaSetup });
  try {
    await connection.onInit();
  } finally {
    await connection.onDestroy();
  }
}

/** The version collection, typed: one document, `{ _id: "agboss", version }`. */
const versionsIn = (db: ReturnType<MongoClient["db"]>) =>
  db.collection<{ _id: string; version: number }>(Collections.SchemaVersion);

const versionDocumentOf = (database: string) =>
  onDatabase(database, (db) => versionsIn(db).findOne({ _id: "agboss" }));

describe("agbossjs/agboss#891 AC1: the schema's version", () => {
  it("AC1: migrateMongodb makes every collection and writes version 1; a second run applies nothing", async () => {
    const database = freshDatabase();

    const first = await migrateMongodb({ url: REPLICA_SET_URL, database });
    const second = await migrateMongodb({ url: REPLICA_SET_URL, database });

    expect(first).toEqual({ database, applied: [{ version: 1, name: "stores" }], version: 1 });
    expect(second).toEqual({ database, applied: [], version: 1 });
    expect(await versionDocumentOf(database)).toMatchObject({ _id: "agboss", version: 1 });
    const names = await onDatabase(database, async (db) =>
      (await db.listCollections({}, { nameOnly: true }).toArray()).map((info) => info.name),
    );
    expect(names).toEqual(expect.arrayContaining(Object.values(Collections)));
  });

  it("AC1: concurrent migrations end in one schema at version 1", async () => {
    const database = freshDatabase();

    const reports = await Promise.all(
      [1, 2, 3].map(() => migrateMongodb({ url: REPLICA_SET_URL, database })),
    );

    expect(reports.every((report) => report.version === 1)).toBe(true);
    expect(await versionDocumentOf(database)).toMatchObject({ version: 1 });
    await expect(startOn(database)).resolves.toBeUndefined();
  });

  it("AC1: SchemaSetup.Check (the default) refuses a database never migrated — and creates nothing", async () => {
    const database = freshDatabase();

    const refused = startOn(database);

    await expect(refused).rejects.toThrow(MongoSchemaMissingError);
    await expect(refused).rejects.toMatchObject({
      code: "mongodb.schema-missing",
      applied: undefined,
      expected: 1,
      collections: [],
    });
    await expect(refused).rejects.toThrow(
      /run `npx agboss-mongodb migrate` with MONGODB_URL set in the environment/,
    );
    const names = await onDatabase(database, async (db) =>
      (await db.listCollections({}, { nameOnly: true }).toArray()).map((info) => info.name),
    );
    expect(names).toEqual([]);
  });

  it("AC1: SchemaSetup.Check refuses an older version", async () => {
    const database = freshDatabase();
    await migrateMongodb({ url: REPLICA_SET_URL, database });
    await onDatabase(database, (db) =>
      versionsIn(db).updateOne({ _id: "agboss" }, { $set: { version: 0 } }),
    );

    await expect(startOn(database, SchemaSetup.Check)).rejects.toMatchObject({
      code: "mongodb.schema-missing",
      applied: 0,
      expected: 1,
    });
  });

  it("AC1: SchemaSetup.Check refuses a migrated database a stores' collection was dropped from", async () => {
    const database = freshDatabase();
    await migrateMongodb({ url: REPLICA_SET_URL, database });
    await onDatabase(database, (db) => db.collection(Collections.OutboundCalls).drop());

    await expect(startOn(database)).rejects.toMatchObject({
      code: "mongodb.schema-missing",
      applied: 1,
      collections: [Collections.OutboundCalls],
    });
  });

  it("AC1: a newer schema is MongoSchemaTooNewError at start and at migrate, the version left as it is", async () => {
    const database = freshDatabase();
    await migrateMongodb({ url: REPLICA_SET_URL, database });
    await onDatabase(database, (db) =>
      versionsIn(db).updateOne({ _id: "agboss" }, { $set: { version: 7 } }),
    );

    await expect(startOn(database, SchemaSetup.Check)).rejects.toThrow(MongoSchemaTooNewError);
    await expect(startOn(database, SchemaSetup.MigrateOnStart)).rejects.toMatchObject({
      code: "mongodb.schema-too-new",
      applied: 7,
      expected: 1,
    });
    await expect(migrateMongodb({ url: REPLICA_SET_URL, database })).rejects.toThrow(
      MongoSchemaTooNewError,
    );
    expect(await versionDocumentOf(database)).toMatchObject({ version: 7 });
  });

  it("AC1: SchemaSetup.MigrateOnStart migrates a database never migrated, then a Check start passes", async () => {
    const database = freshDatabase();

    await startOn(database, SchemaSetup.MigrateOnStart);

    expect(await versionDocumentOf(database)).toMatchObject({ version: 1 });
    await expect(startOn(database, SchemaSetup.Check)).resolves.toBeUndefined();
  });

  it("AC1: an aborted migration changes nothing", async () => {
    const database = freshDatabase();
    const controller = new AbortController();
    controller.abort();

    await expect(
      migrateMongodb({ url: REPLICA_SET_URL, database, signal: controller.signal }),
    ).rejects.toThrow();
    expect(await versionDocumentOf(database)).toBeNull();
  });
});

describe("agbossjs/agboss#891 AC4: a start refused, then retried on the same connection", () => {
  it("AC4: the refusal closes the client and is not kept: once migrated, the next onInit passes", async () => {
    const database = freshDatabase();
    const connection = new MongoConnection({ url: REPLICA_SET_URL, database });
    try {
      await expect(connection.onInit()).rejects.toThrow(MongoSchemaMissingError);
      await migrateMongodb({ url: REPLICA_SET_URL, database });

      await expect(connection.onInit()).resolves.toBeUndefined();
      await expect(connection.ping()).resolves.toBeUndefined();
    } finally {
      await connection.onDestroy();
    }
  });
});
