import type { ConformanceStore, StoreSeam } from "@agboss/core/testing/contracts";
import { afterAll } from "vitest";
import type { MongoConnection } from "../../src/index.js";
import { openConnection, type TestDatabase } from "../support/database.js";

/**
 * A MongoDB store as one entry of `storeConformance` (agbossjs/agboss#526): each instance on a
 * client of its own — two application instances on one replica set, as two pods are. A client is
 * opened once per instance id and database, and kept for the file: the interleaving explorer
 * builds its instances again for every schedule it runs, and a client per schedule (its pool, its
 * three monitors) would open tens of thousands of connections. The set's `reset` empties the
 * database before each case.
 */

/** How a test builds one instance's store on that instance's connection. */
export type MongoStoreFactory<TStore> = (
  connection: MongoConnection,
  seam: StoreSeam,
) => TStore | Promise<TStore>;

/** Each instance's connection, by database and instance id. */
const connections = new Map<string, Promise<MongoConnection>>();

afterAll(async () => {
  const opened = [...connections.values()];
  connections.clear();
  for (const connection of opened) await (await connection).onDestroy();
});

/** The connection of `instanceId` on `database`, opened on first use. */
export function instanceConnection(
  database: TestDatabase,
  instanceId: string,
): Promise<MongoConnection> {
  const key = JSON.stringify([database.url(), instanceId]);
  const opened = connections.get(key) ?? openConnection(database.url());
  connections.set(key, opened);
  return opened;
}

export function mongoStore<TStore extends object>(
  database: TestDatabase,
  make: MongoStoreFactory<TStore>,
): ConformanceStore<TStore> {
  return {
    instance: async (seam) => make(await instanceConnection(database, seam.instanceId), seam),
  };
}
