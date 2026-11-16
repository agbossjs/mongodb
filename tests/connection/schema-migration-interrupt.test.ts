/**
 * agbossjs/agboss#1103 item 3 — the migration to schema 3 is interrupt-safe only because the version
 * is raised LAST, after the pauses' `channel` backfill. A run stopped in the middle of the backfill
 * leaves the version at 2, and the run after it completes the backfill and raises the version. With
 * the order flipped (the version first) the stopped run would leave version 4 behind and the next run
 * would skip the backfill for good.
 */
import { PauseStatus } from "@agboss/core";
import { MongoClient, type Db } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { Collections, migrateMongodb } from "../../src/index.js";
import { idOf } from "../../src/stores/keys.js";
import { dropDatabase } from "../support/database.js";
import { pauseOf } from "../support/pauses.js";
import { freshDatabaseName, REPLICA_SET_URL } from "../support/server.js";

const made: string[] = [];
afterAll(async () => {
  for (const database of made) await dropDatabase(database);
});

async function onDatabase<T>(database: string, work: (db: Db) => Promise<T>): Promise<T> {
  const client = new MongoClient(REPLICA_SET_URL);
  try {
    return await work(client.db(database));
  } finally {
    await client.close();
  }
}

/** A database at version 2 with three pauses that have no `channel` (written before version 3). */
async function databaseAtVersion2(): Promise<string> {
  const database = freshDatabaseName();
  made.push(database);
  await migrateMongodb({ url: REPLICA_SET_URL, database });
  await onDatabase(database, async (db) => {
    await db
      .collection<{ _id: string }>(Collections.SchemaVersion)
      .updateOne({ _id: "agboss" }, { $set: { version: 2 } });
    const pauses = db.collection<{ _id: string; [field: string]: unknown }>(Collections.Pauses);
    for (const [index, id] of ["p1", "p2", "p3"].entries())
      await pauses.insertOne({
        _id: idOf("default", id),
        tenantId: "default",
        pauseId: id,
        rootExecutionId: "run-1",
        stepKey: pauseOf(id).stepKey,
        seq: index + 1,
        status: PauseStatus.Pending,
        isSent: true,
        resolvedAt: null,
        record: JSON.stringify(pauseOf(id)),
        closing: null,
      });
  });
  return database;
}

/** A signal that aborts the run at its `limit`-th check: the process killed at that point of the run. */
function abortingAtCheck(limit: number): AbortSignal {
  let checks = 0;
  return new Proxy(new AbortController().signal, {
    get(target, property) {
      if (property !== "throwIfAborted") return Reflect.get(target, property) as unknown;
      return (): void => {
        checks += 1;
        if (checks >= limit) throw new Error("killed in the backfill");
      };
    },
  });
}

const stateOf = (database: string) =>
  onDatabase(database, async (db) => ({
    version: (
      await db.collection<{ _id: string; version: number }>(Collections.SchemaVersion).findOne({
        _id: "agboss",
      })
    )?.version,
    withoutChannel: await db
      .collection(Collections.Pauses)
      .countDocuments({ channel: { $exists: false } }),
  }));

describe("agbossjs/agboss#1103: the migration to schema 3 is interrupt-safe", () => {
  it("a run killed in the middle of the backfill leaves version 2; the next run completes the backfill", async () => {
    const database = await databaseAtVersion2();

    await expect(
      migrateMongodb({ url: REPLICA_SET_URL, database, signal: abortingAtCheck(4) }),
    ).rejects.toThrow(/killed in the backfill/u);
    const stopped = await stateOf(database);
    await migrateMongodb({ url: REPLICA_SET_URL, database });
    const finished = await stateOf(database);

    expect(stopped.version).toBe(2);
    expect(stopped.withoutChannel).toBeGreaterThan(0);
    expect(finished).toEqual({ version: 4, withoutChannel: 0 });
  });
});
