/**
 * Two migrations of one new database at once (agbossjs/agboss#891, #1213): what each run meets
 * when the other one is a step ahead. The other run is played by the database itself: a command
 * really done, then answered as the server answers the run that lost the race. A collection made
 * in between is there, as wanted (NamespaceExists, 48), and a version document upserted in between
 * is raised again (E11000). Any other failure fails the run.
 */
import { MongoClient, MongoServerError, type Collection, type Db } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { Collections } from "../../src/index.js";
import { migrateSchema, SCHEMA_VERSION } from "../../src/connection/schema-version.js";
import { dropDatabase } from "../support/database.js";
import { freshDatabaseName, REPLICA_SET_URL } from "../support/server.js";

const client = new MongoClient(REPLICA_SET_URL);
const made: string[] = [];

afterAll(async () => {
  await client.close();
  for (const database of made) await dropDatabase(database);
});

const freshDb = (): Db => {
  const name = freshDatabaseName();
  made.push(name);
  return client.db(name);
};

/** A server error with `code`, as the driver gives one. */
const serverError = (code: number): MongoServerError =>
  new MongoServerError({ code, errmsg: `the server's error ${String(code)}` });

/** `target[key]`, a method bound to `target`. */
function boundMember(target: object, key: string | symbol): unknown {
  const value: unknown = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
}

/**
 * The version collection of `db` whose first upsert is done and then answered with `error`
 * (`afterDone`), or answered with it without being done.
 */
function versionsRacing(db: Db, error: MongoServerError, afterDone: boolean): Db {
  let pending = true;
  const racing = (versions: Collection): Collection =>
    new Proxy(versions, {
      get(target, key) {
        if (key !== "updateOne" || !pending) return boundMember(target, key);
        return async (...args: Parameters<Collection["updateOne"]>) => {
          pending = false;
          if (afterDone) await target.updateOne(...args);
          throw error;
        };
      },
    });
  return new Proxy(db, {
    get(target, key) {
      if (key !== "collection") return boundMember(target, key);
      return (...args: Parameters<Db["collection"]>) => {
        const collection = target.collection(...args);
        return args[0] === Collections.SchemaVersion ? racing(collection) : collection;
      };
    },
  });
}

/** `db` whose first `createCollection` of `name` is done and then answered with `error`. */
function creationRacing(db: Db, name: string, error: MongoServerError): Db {
  let pending = true;
  return new Proxy(db, {
    get(target, key) {
      if (key !== "createCollection") return boundMember(target, key);
      return async (...args: Parameters<Db["createCollection"]>) => {
        if (!pending || args[0] !== name) return target.createCollection(...args);
        pending = false;
        await target.createCollection(...args);
        throw error;
      };
    },
  });
}

const versionOf = async (db: Db): Promise<unknown> =>
  (
    await db
      .collection(Collections.SchemaVersion)
      .findOne({}, { projection: { _id: 0, version: 1 } })
  )?.version;

describe("two migrations of a new database at once", () => {
  it("the version upserted by the other run (E11000) is raised again: the run passes, at this version", async () => {
    const db = freshDb();

    await migrateSchema(versionsRacing(db, serverError(11000), true));

    expect(await versionOf(db)).toBe(SCHEMA_VERSION);
  });

  it("a version write failing otherwise fails the run, with the server's error", async () => {
    const db = freshDb();
    const error = serverError(9001);

    await expect(migrateSchema(versionsRacing(db, error, false))).rejects.toBe(error);
    expect(await versionOf(db)).toBeUndefined();
  });

  it("a collection the other run made (NamespaceExists, 48) is there, as wanted: the run passes", async () => {
    const db = freshDb();

    await migrateSchema(creationRacing(db, Collections.ExecutionLeases, serverError(48)));

    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(
      (one) => one.name,
    );
    expect(names).toContain(Collections.ExecutionLeases);
    expect(await versionOf(db)).toBe(SCHEMA_VERSION);
  });

  it("a creation failing otherwise fails the run, with the server's error, and writes no version", async () => {
    const db = freshDb();
    const error = serverError(13);

    await expect(
      migrateSchema(creationRacing(db, Collections.ExecutionLeases, error)),
    ).rejects.toBe(error);
    expect(await versionOf(db)).toBeUndefined();
  });
});
