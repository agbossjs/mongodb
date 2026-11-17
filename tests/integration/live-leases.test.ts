/**
 * agbossjs/agboss#1104 (ADR-0034) — a schema upgrade is stop every old instance, migrate, then
 * deploy, and `migrate` enforces what it can see: with migrations pending on a migrated database, an
 * execution lease live on the server's clock refuses the run (`MongoLiveLeasesError`, the count and
 * up to 5 holders), nothing applied, unless `allowLiveLeases`. A database at this package's version
 * stays a no-op whatever is live. A start with `SchemaSetup.MigrateOnStart` is held to the same rule
 * (agbossjs/agboss#1260: it waits for the leases to lapse first; `migrate-on-start-leases.test.ts`).
 */
import { SchemaSetup } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { MongoClient, type Db } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import {
  Collections,
  migrateMongodb,
  MongoConnection,
  MongoLiveLeasesError,
} from "../../src/index.js";
import { MIGRATIONS, SCHEMA_VERSION } from "../../src/connection/schema-version.js";
import { treeIdOf } from "../../src/stores/keys.js";
import { dropDatabase } from "../support/database.js";
import { freshDatabaseName, REPLICA_SET_URL } from "../support/server.js";

const made: string[] = [];
afterAll(async () => {
  for (const database of made) await dropDatabase(database);
});

const HOUR = 3_600_000;

/** `work` on a plain client of `database`. */
async function onDatabase<T>(database: string, work: (db: Db) => Promise<T>): Promise<T> {
  const client = new MongoClient(REPLICA_SET_URL);
  try {
    return await work(client.db(database));
  } finally {
    await client.close();
  }
}

/** A database migrated, then its version set back to `version`: the schema of the version before. */
async function databaseAt(version: number): Promise<string> {
  const database = freshDatabaseName();
  made.push(database);
  await migrateMongodb({ url: REPLICA_SET_URL, database });
  await onDatabase(database, (db) =>
    db
      .collection<{ _id: string }>(Collections.SchemaVersion)
      .updateOne({ _id: "agboss" }, { $set: { version } }),
  );
  return database;
}

const versionOf = (database: string): Promise<unknown> =>
  onDatabase(
    database,
    async (db) =>
      (
        await db
          .collection<{ _id: string; version: number }>(Collections.SchemaVersion)
          .findOne({ _id: "agboss" }, { projection: { _id: 0, version: 1 } })
      )?.version,
  );

interface Lease {
  readonly root: string;
  readonly holder?: string;
  readonly at?: number;
  readonly flags?: Partial<Record<"released" | "finished" | "superseded", boolean>>;
  readonly token?: number;
}

/** A lease document as a store writes it: by default held by `instance-1` and live for an hour. */
async function leased(database: string, ...leases: readonly Lease[]): Promise<void> {
  await onDatabase(database, (db) =>
    db.collection<{ _id: string }>(Collections.ExecutionLeases).insertMany(
      leases.map((lease) => ({
        _id: treeIdOf("default", lease.root),
        ...{ tenantId: "default", rootExecutionId: lease.root },
        holderInstanceId: lease.holder ?? "instance-1",
        token: lease.token ?? 1,
        expiresAt: new Date(Date.now() + (lease.at ?? HOUR)),
        ...{ released: false, yielded: false, superseded: false, finished: false },
        ...lease.flags,
      })),
    ),
  );
}

const migrate = (database: string, allowLiveLeases?: boolean) =>
  migrateMongodb({
    url: REPLICA_SET_URL,
    database,
    ...(allowLiveLeases === undefined ? {} : { allowLiveLeases }),
  });

describe("agbossjs/agboss#1104: migrate refuses while an execution lease is live", () => {
  it("an older schema and a live lease: MongoLiveLeasesError with the count and the holders, nothing applied", async () => {
    const database = await databaseAt(SCHEMA_VERSION - 1);
    await leased(database, { root: "a" }, { root: "b", holder: "instance-2" }, { root: "c" });

    const refused = migrate(database);

    await expect(refused).rejects.toThrow(MongoLiveLeasesError);
    await expect(refused).rejects.toMatchObject({
      code: "mongodb.live-leases",
      count: 3,
      holders: ["instance-1", "instance-2"],
    });
    await expect(refused).rejects.toThrow(/stop every old instance/u);
    expect(await versionOf(database)).toBe(SCHEMA_VERSION - 1);
  });

  it("allowLiveLeases: true migrates anyway", async () => {
    const database = await databaseAt(SCHEMA_VERSION - 1);
    await leased(database, { root: "a" });

    const report = await migrate(database, true);

    expect(report.applied.map((one) => one.version)).toEqual([SCHEMA_VERSION]);
    expect(await versionOf(database)).toBe(SCHEMA_VERSION);
  });

  it("a database at this version is a no-op whatever is live", async () => {
    const database = await databaseAt(SCHEMA_VERSION);
    await leased(database, { root: "a" });

    expect(await migrate(database)).toEqual({ database, applied: [], version: SCHEMA_VERSION });
  });

  it("a database never migrated has no instance to stop: the live leases are not looked at", async () => {
    const database = freshDatabaseName();
    made.push(database);
    await leased(database, { root: "a" });

    const report = await migrate(database);

    expect(report.applied).toHaveLength(MIGRATIONS.length);
  });

  it.each([
    ["expired on the server's clock", { root: "a", at: -1000 }],
    ["released", { root: "a", flags: { released: true } }],
    ["finished", { root: "a", flags: { finished: true } }],
    ["superseded by an outbound call's check", { root: "a", flags: { superseded: true } }],
    [
      "a seed document of a cancel before the first acquire (token 0, released)",
      {
        root: "a",
        token: 0,
        holder: "",
        at: -HOUR,
        flags: { released: true },
      },
    ],
  ] as const)("a lease that is %s is not live", async (_name, lease) => {
    const database = await databaseAt(SCHEMA_VERSION - 1);
    await leased(database, lease);

    const report = await migrate(database);

    expect(report.applied.map((one) => one.version)).toEqual([SCHEMA_VERSION]);
  });

  it("the holders are at most 5, sorted; the count is all of them", async () => {
    const database = await databaseAt(SCHEMA_VERSION - 1);
    await leased(
      database,
      ...["g", "f", "e", "d", "c", "b", "a"].map((id) => ({
        root: `root-${id}`,
        holder: `i-${id}`,
      })),
    );

    await expect(migrate(database)).rejects.toMatchObject({
      count: 7,
      holders: ["i-a", "i-b", "i-c", "i-d", "i-e"],
    });
  });

  it("a 0.1.0 document (leaseEpoch, no token) that is live counts", async () => {
    const database = await databaseAt(SCHEMA_VERSION - 1);
    await onDatabase(database, (db) =>
      db
        .collection<{ _id: string } & Record<string, unknown>>(Collections.ExecutionLeases)
        .insertOne({
          _id: treeIdOf("default", "old"),
          ...{ tenantId: "default", rootExecutionId: "old", holderInstanceId: "old-pod" },
          leaseEpoch: 4,
          expiresAt: new Date(Date.now() + HOUR),
          ...{ released: false, yielded: false, superseded: false, finished: false },
        }),
    );

    await expect(migrate(database)).rejects.toMatchObject({ count: 1, holders: ["old-pod"] });
  });

  it("a start with SchemaSetup.MigrateOnStart over a live lease is refused too (#1260), nothing applied", async () => {
    const database = await databaseAt(SCHEMA_VERSION - 1);
    await leased(database, { root: "a" });
    // a clock whose sleeps end at once: the start's wait is over without the minutes
    const clock = new (class extends VirtualClock {
      override sleep(): Promise<void> {
        return Promise.resolve();
      }
    })();
    const connection = new MongoConnection(
      { url: REPLICA_SET_URL, database, schemaSetup: SchemaSetup.MigrateOnStart },
      clock,
    );

    try {
      await expect(connection.onInit()).rejects.toThrow(MongoLiveLeasesError);
    } finally {
      await connection.onDestroy();
    }

    expect(await versionOf(database)).toBe(SCHEMA_VERSION - 1);
  });
});
