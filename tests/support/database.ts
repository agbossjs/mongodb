import { SchemaSetup } from "@agboss/core/stores";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll } from "vitest";
import { seedLedgerMark } from "../../src/connection/ledger-mark.js";
import { Collections, MongoConnection } from "../../src/index.js";
import { DROP_BOUND_MS, dropOnServer } from "./drop-databases.js";
import { freshDatabaseName, REPLICA_SET_URL } from "./server.js";

/**
 * The database of one test file: a database of its own (`t_<uuid>`) on `AGBOSS_MONGODB_TEST_URL`,
 * its collections and indexes made as a connection's start makes them, dropped after the file.
 */

/** The replica set's URL with `database` as its path. */
export function urlOnDatabase(url: string, database: string): string {
  return url.replace(/^(mongodb(?:\+srv)?:\/\/[^/?]*)\/?[^?]*/u, `$1/${database}`);
}

/** What a test file's database gives: its URL and name (after `beforeAll`). */
export interface TestDatabase {
  readonly url: () => string;
  readonly name: () => string;
}

/** A connection of the test on `url`, started (its schema migrated: `SchemaSetup.MigrateOnStart`). */
export async function openConnection(url: string): Promise<MongoConnection> {
  const connection = new MongoConnection({ url, schemaSetup: SchemaSetup.MigrateOnStart });
  await connection.onInit();
  return connection;
}

/** Drops `database` on the replica set, within `DROP_BOUND_MS` (agbossjs/agboss#985); a failure names it. */
export async function dropDatabase(database: string): Promise<void> {
  const client = new MongoClient(REPLICA_SET_URL);
  try {
    await dropOnServer(client)(database, DROP_BOUND_MS).catch((error: unknown) => {
      throw new Error(`dropping the test database ${database}: ${String(error)}`, { cause: error });
    });
  } finally {
    await client.close();
  }
}

/**
 * The Stryker worker this process runs for (Stryker sets it in each of its test runners), else
 * `undefined`: a plain test run.
 */
const STRYKER_WORKER = process.env.STRYKER_MUTATOR_WORKER;

/** How many `testDatabase()`s this file has asked for so far. */
let databasesOfFile = 0;

/**
 * Every index of `database` but `_id`'s dropped and its schema version forgotten, so that the migration of the
 * next start makes them again: the database of a worker is kept between mutants, and
 * the schema a mutant of `schema.ts` makes (an index with another key) must not meet the index the
 * run before made (`IndexKeySpecsConflict` in the migration of `beforeAll`: a RuntimeError, which
 * Stryker leaves out of the score instead of killing the mutant; agbossjs/mongodb#103).
 */
async function resetSchemaOf(database: string): Promise<void> {
  const client = new MongoClient(REPLICA_SET_URL);
  try {
    const db = client.db(database);
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    await Promise.all(
      collections.map(({ name }) =>
        db
          .collection(name)
          .dropIndexes()
          .catch(() => undefined),
      ),
    );
  } finally {
    await client.close();
  }
}

/**
 * Under Stryker, the databases of this test process (agbossjs/agboss#1213): Stryker runs a file
 * again for every mutant, and a database per file and run — dozens of collections and their
 * indexes, hundreds of times, or kept, one per file — grew the primary's memory past 1 GB (the
 * server keeps a handle per collection and index) until it was OOM-killed. A test process (the
 * runner's `STRYKER_MUTATOR_WORKER`, its fork's `VITEST_POOL_ID`) runs its files one at a time, so
 * it keeps one database per `testDatabase()` of a file (the first, the second: the module is
 * loaded again for each file), migrated once, and every file starts from the state a fresh one
 * has: every store collection's documents removed, the ledger's mark seeded again, any other
 * collection dropped.
 */
async function reusedDatabase(worker: string, index: number): Promise<string> {
  const name = `t_mutation_${worker}_${process.env.VITEST_POOL_ID ?? "0"}_${String(index)}`;
  // only the shard of the schema: the others keep the indexes they migrated once, which is what makes a reused database fast
  if (process.env.MUTATION_SHARD === "migrations") await resetSchemaOf(name);
  const connection = await openConnection(urlOnDatabase(REPLICA_SET_URL, name));
  try {
    const stores = new Set<string>(Object.values(Collections));
    const all = await connection.db.listCollections({}, { nameOnly: true }).toArray();
    const emptied = all
      .map(({ name: collection }) => collection)
      .filter((collection) => collection !== Collections.SchemaVersion);
    await Promise.all(
      emptied.map(async (collection) => {
        const it = connection.db.collection(collection);
        if (stores.has(collection)) await it.deleteMany({}, { writeConcern: { w: "majority" } });
        else await it.drop();
      }),
    );
    await seedLedgerMark(connection.db);
  } finally {
    await connection.onDestroy();
  }
  return name;
}

/**
 * The file's database, created with the stores' schema before its tests and dropped after them
 * (under Stryker, the worker's own, emptied instead: `reusedDatabase`).
 */
export function testDatabase(): TestDatabase {
  const index = databasesOfFile;
  databasesOfFile += 1;
  let name: string | undefined;
  beforeAll(async () => {
    if (STRYKER_WORKER !== undefined) {
      name = await reusedDatabase(STRYKER_WORKER, index);
      return;
    }
    name = freshDatabaseName();
    const connection = await openConnection(urlOnDatabase(REPLICA_SET_URL, name));
    await connection.onDestroy();
  });
  afterAll(async () => {
    if (name !== undefined && STRYKER_WORKER === undefined) await dropDatabase(name);
  });
  const current = (): string => {
    if (name === undefined) throw new Error("the test database is created in beforeAll");
    return name;
  };
  return { url: () => urlOnDatabase(REPLICA_SET_URL, current()), name: current };
}

/**
 * The clients of `emptyAll`, one per URL, kept for the file: a reset runs before every case and
 * every schedule of the explorer, and a client per reset (its pool, three monitors) would open
 * connections faster than the host frees their ports.
 */
const resetClients = new Map<string, MongoClient>();

afterAll(async () => {
  const clients = [...resetClients.values()];
  resetClients.clear();
  for (const client of clients) await client.close();
});

/**
 * Every document of the stores' collections (and the tests' own) removed: a contract case's reset —
 * the ledger's mark seeded again, as a new database has it (agbossjs/agboss#798), the schema's
 * version kept (agbossjs/agboss#891: the database stays migrated).
 */
export async function emptyAll(url: string, extra: readonly string[] = []): Promise<void> {
  const client = resetClients.get(url) ?? new MongoClient(url);
  resetClients.set(url, client);
  const db = client.db();
  await Promise.all(
    [...Object.values(Collections), ...extra]
      .filter((name) => name !== Collections.SchemaVersion)
      .map((name) => db.collection(name).deleteMany({}, { writeConcern: { w: "majority" } })),
  );
  await seedLedgerMark(db);
}
