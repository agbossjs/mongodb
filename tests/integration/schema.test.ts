/**
 * agbossjs/agboss#527 AC3 — the stores compare keys byte for byte: their collections are made with
 * the simple collation, and one an operator made with another collation is refused at start.
 */
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import {
  Collections,
  MongoCollationError,
  MongoConnection,
  MongoExecutionTreeRepository,
} from "../../src/index.js";
import { dropDatabase, openConnection, urlOnDatabase } from "../support/database.js";
import { freshDatabaseName, REPLICA_SET_URL } from "../support/server.js";

const made: string[] = [];

afterAll(async () => {
  for (const database of made) await dropDatabase(database);
});

/** A new database of this file: its URL. */
const freshUrl = (): string => {
  const database = freshDatabaseName();
  made.push(database);
  return urlOnDatabase(REPLICA_SET_URL, database);
};

describe("agbossjs/agboss#527: the stores' collections and their collation", () => {
  it("the start makes every collection with the simple collation; a second start changes nothing", async () => {
    const url = freshUrl();
    const connection = await openConnection(url);
    try {
      await connection.onInit();
      const infos = await connection.db.listCollections().toArray();
      const names = infos.map((info) => info.name);

      expect(names).toEqual(expect.arrayContaining(Object.values(Collections)));
      await expect(openConnection(url).then((again) => again.onDestroy())).resolves.toBeUndefined();
    } finally {
      await connection.onDestroy();
    }
  });

  it("Zoë-17, Zoe-17 (e + U+0308) and zoe-17 are three keys of a tree, never one", async () => {
    const connection = await openConnection(freshUrl());
    try {
      const trees = new MongoExecutionTreeRepository(connection);
      const tree = { tenantId: "default", rootExecutionId: "root-1" };
      const saved = [];
      for (const key of ["Zoë-17", "Zoë-17", "zoe-17", "Zoë-17"])
        saved.push(await trees.saveIfAbsentInTree(tree, key, key));

      expect(saved).toEqual([true, true, true, false]);
      expect(await trees.findByIdInTree(tree, "Zoë-17")).toBe("Zoë-17");
    } finally {
      await connection.onDestroy();
    }
  });

  it("a stores' collection made with a case-insensitive collation is MongoCollationError at start", async () => {
    const url = freshUrl();
    const client = new MongoClient(url);
    try {
      await client.db().createCollection(Collections.FencedEffectResults, {
        collation: { locale: "en", strength: 2 },
      });
      const connection = new MongoConnection({ url });
      const refused = connection.onInit();

      await expect(refused).rejects.toThrow(MongoCollationError);
      await expect(refused).rejects.toMatchObject({
        code: "mongodb.collation-not-simple",
        collections: [Collections.FencedEffectResults],
      });
      await connection.onDestroy();
    } finally {
      await client.close();
    }
  });

  it("a database named in the URL is the stores' database", async () => {
    const url = freshUrl();
    const connection = new MongoConnection({ url });
    try {
      expect(connection.db.databaseName).toBe(made.at(-1));
    } finally {
      await connection.onDestroy();
    }
  });
});
