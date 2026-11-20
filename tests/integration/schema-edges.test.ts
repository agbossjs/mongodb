/**
 * agbossjs/mongodb#100 (the migrations shard's survivors of a cold CI run, which a local run counted
 * as timeouts): which collections the collation check looks at, that the ledger is made with its
 * mark, that a second run of the schema makes nothing again, and that the collections are listed by
 * name only.
 */
import { MongoClient } from "mongodb";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { LEDGER_MARK_ID } from "../../src/connection/ledger-mark.js";
import {
  collatedCollectionsOf,
  ensureSchema,
  existingCollectionsOf,
} from "../../src/connection/schema.js";
import { Collections } from "../../src/index.js";
import { dropDatabase } from "../support/database.js";
import { freshDatabaseName, REPLICA_SET_URL } from "../support/server.js";

const clients: MongoClient[] = [];
const made: string[] = [];

/** A database of this file that nothing has migrated, on a client of its own. */
function freshDb() {
  const name = freshDatabaseName();
  made.push(name);
  const client = new MongoClient(REPLICA_SET_URL);
  clients.push(client);
  return client.db(name);
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  for (const name of made) await dropDatabase(name);
});

describe("which collections the collation check looks at", () => {
  it("only the stores': another collection with another collation is none of its business", async () => {
    const db = freshDb();
    await db.createCollection("someone_elses", { collation: { locale: "en" } });

    expect(await collatedCollectionsOf(db)).toEqual([]);
    await expect(ensureSchema(db)).resolves.toBeUndefined();
  });

  it("a store's collection with another collation is named", async () => {
    const db = freshDb();
    await db.createCollection("someone_elses", { collation: { locale: "en" } });
    await db.createCollection(Collections.ExecutionLeases, { collation: { locale: "en" } });

    expect(await collatedCollectionsOf(db)).toEqual([Collections.ExecutionLeases]);
  });
});

describe("the schema of a database that has none", () => {
  it("makes the ledger with its pruning mark, at the epoch", async () => {
    const db = freshDb();

    await ensureSchema(db);

    const marks = await db
      .collection<{ _id: string; prunedBefore: Date }>(Collections.CostEntries)
      .find({ _id: LEDGER_MARK_ID })
      .toArray();
    expect(marks).toEqual([{ _id: LEDGER_MARK_ID, prunedBefore: new Date(0) }]);
  });

  it("makes nothing again when run a second time", async () => {
    const db = freshDb();
    await ensureSchema(db);
    const create = vi.spyOn(db, "createCollection");

    await ensureSchema(db);

    expect(create).not.toHaveBeenCalled();
  });

  it("lists the collections that exist by name only", async () => {
    const db = freshDb();
    await db.createCollection("a_collection");
    const list = vi.spyOn(db, "listCollections");

    const names = await existingCollectionsOf(db);

    expect(names).toEqual(new Set(["a_collection"]));
    expect(list).toHaveBeenCalledWith({}, { nameOnly: true });
  });
});
