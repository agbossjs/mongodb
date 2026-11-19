/**
 * agbossjs/agboss#891: `migrateMongodb` makes a client of its own for the run and closes it, whether
 * the run migrates or is refused: a script that migrates leaves no connection open behind it.
 */
import { MongoClient } from "mongodb";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { migrateMongodb, MongoDeploymentError } from "../../src/index.js";
import { dropDatabase, urlOnDatabase } from "../support/database.js";
import { freshDatabaseName, REPLICA_SET_URL, STANDALONE_URL } from "../support/server.js";

const made: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const database of made) await dropDatabase(database);
});

describe("migrateMongodb's own client", () => {
  it("a run that migrates closes its client", async () => {
    const database = freshDatabaseName();
    made.push(database);
    const closes = vi.spyOn(MongoClient.prototype, "close");

    await migrateMongodb({ url: urlOnDatabase(REPLICA_SET_URL, database) });

    expect(closes).toHaveBeenCalled();
  });

  it("a run refused (a standalone mongod) closes its client too", async () => {
    const closes = vi.spyOn(MongoClient.prototype, "close");

    await expect(migrateMongodb({ url: STANDALONE_URL })).rejects.toBeInstanceOf(
      MongoDeploymentError,
    );

    expect(closes).toHaveBeenCalled();
  });
});
