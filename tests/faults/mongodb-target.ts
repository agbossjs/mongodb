import { fileURLToPath } from "node:url";
import type { FaultSuiteOptions } from "@agboss/core/testing/faults";
import { MongoClient } from "mongodb";
import { afterAll } from "vitest";
import { z } from "zod";
import { dropDatabase, openConnection, urlOnDatabase } from "../support/database.js";
import { freshDatabaseName, REPLICA_SET_URL } from "../support/server.js";

/**
 * agbossjs/agboss#484 — the fault suite's MongoDB target: before each scenario a database of its
 * own on the replica set, its collections and indexes made; every one dropped after the file. A pod
 * reaches the replica set's primary through a proxy of its own: a direct connection
 * (`directConnection=true`) to one host and port, so the proxy carries every byte the pod sends —
 * a replica-set connection would find the members by their own addresses and go around it. The
 * writes still wait for a majority of the members (`w=majority`): a direct connection changes who
 * the pod talks to, not what an acknowledgement means.
 *
 * Time is the real clock (agbossjs/agboss#607): MongoDB decides a lease's expiry by its own `$$NOW`
 * (agbossjs/agboss#533), at the real rate, so the pods run at 1, and CI shards the scenarios (and the
 * sabotages) over parallel jobs (`shard: "env"`, `AGBOSS_FAULT_SHARD=k/n`) to fit.
 */

/** The store set's module, imported by every pod. */
export const MONGODB_FAULT_STORES = fileURLToPath(
  new URL("./mongodb.fault-stores.ts", import.meta.url),
);

const Hello = z.object({ primary: z.string() });

/** The replica set's primary, `host:port`, as its members name it. */
export async function primaryOf(url: string): Promise<string> {
  const client = new MongoClient(url);
  try {
    return Hello.parse(await client.db("admin").command({ hello: 1 })).primary;
  } finally {
    await client.close();
  }
}

/** A direct connection's URL to `primary`, on `database`. */
export const directUrlOf = (primary: string, database: string): string =>
  `mongodb://${primary}/${database}?directConnection=true`;

/** The fault suite's options on fresh databases of this file's own, on the real clock. */
export function mongoFaultTarget(): FaultSuiteOptions {
  const databases: string[] = [];
  let url = "";
  afterAll(async () => {
    for (const database of databases) await dropDatabase(database);
  });
  return {
    name: "MongoDB",
    storesModule: MONGODB_FAULT_STORES,
    timeScale: 1,
    // CI's parallel jobs: AGBOSS_FAULT_SHARD=k/n, read by the suite (agbossjs/agboss#831) — the
    // core's sabotages included, each passing only when it breaks its invariant
    shard: "env",
    database: {
      get url() {
        return url;
      },
      reset: async () => {
        const database = freshDatabaseName();
        databases.push(database);
        const connection = await openConnection(urlOnDatabase(REPLICA_SET_URL, database));
        await connection.onDestroy();
        url = directUrlOf(await primaryOf(REPLICA_SET_URL), database);
      },
    },
  };
}
