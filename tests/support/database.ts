import { MongoClient } from "mongodb";
import { afterAll, beforeAll } from "vitest";
import { Collections, MongoConnection } from "../../src/index.js";
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

/** A connection of the test on `url`, started (its schema made). */
export async function openConnection(url: string): Promise<MongoConnection> {
  const connection = new MongoConnection({ url });
  await connection.onInit();
  return connection;
}

/** Drops `database` on the replica set. */
export async function dropDatabase(database: string): Promise<void> {
  const client = new MongoClient(REPLICA_SET_URL);
  try {
    await client.db(database).dropDatabase();
  } finally {
    await client.close();
  }
}

/** The file's database, created with the stores' schema before its tests and dropped after them. */
export function testDatabase(): TestDatabase {
  let name: string | undefined;
  beforeAll(async () => {
    name = freshDatabaseName();
    const connection = await openConnection(urlOnDatabase(REPLICA_SET_URL, name));
    await connection.onDestroy();
  });
  afterAll(async () => {
    if (name !== undefined) await dropDatabase(name);
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

/** Every document of the stores' collections (and the tests' own) removed: a contract case's reset. */
export async function emptyAll(url: string, extra: readonly string[] = []): Promise<void> {
  const client = resetClients.get(url) ?? new MongoClient(url);
  resetClients.set(url, client);
  const db = client.db();
  await Promise.all(
    [...Object.values(Collections), ...extra].map((name) =>
      db.collection(name).deleteMany({}, { writeConcern: { w: "majority" } }),
    ),
  );
}
