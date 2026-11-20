/**
 * agbossjs/mongodb#99: what the connection does with its client's resources: a transaction ends
 * its session, whatever the work did; the stop closes the client; a document is stored as it was
 * given (a field left `undefined` is left out, never written as `null`).
 */
import { MongoClient, type ClientSession } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoConnection, MongoSchemaMissingError } from "../../src/index.js";
import {
  dropDatabase,
  emptyAll,
  openConnection,
  testDatabase,
  urlOnDatabase,
} from "../support/database.js";
import { freshDatabaseName, REPLICA_SET_URL } from "../support/server.js";

const database = testDatabase();
const UNREACHABLE = "mongodb://127.0.0.1:1/?replicaSet=rs0&serverSelectionTimeoutMS=200";

/** The sessions `connection` starts from now on. */
function sessionsOf(connection: MongoConnection): ClientSession[] {
  const sessions: ClientSession[] = [];
  const start = connection.client.startSession.bind(connection.client);
  vi.spyOn(connection.client, "startSession").mockImplementation((options) => {
    const session = start(options);
    sessions.push(session);
    return session;
  });
  return sessions;
}

describe("the stop", () => {
  it("closes the client", async () => {
    const connection = new MongoConnection({ url: UNREACHABLE });
    const close = vi.spyOn(connection.client, "close");

    await connection.onDestroy();

    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("a transaction ends its session", () => {
  it("when the work failed", async () => {
    const connection = new MongoConnection({ url: UNREACHABLE });
    const sessions = sessionsOf(connection);
    try {
      await expect(
        connection.inTransaction(() => Promise.reject(new Error("work"))),
      ).rejects.toThrow();

      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.hasEnded).toBe(true);
    } finally {
      await connection.onDestroy();
    }
  });
});

describe("on a real replica set", () => {
  let connection: MongoConnection;

  beforeAll(async () => {
    connection = await openConnection(database.url());
  });
  afterAll(async () => {
    await connection.onDestroy();
  });
  beforeEach(() => emptyAll(database.url(), ["lifecycle_documents"]));

  it("a transaction that committed returns the work's result and ends its session", async () => {
    const sessions = sessionsOf(connection);

    const result = await connection.inTransaction(async ({ session }) => {
      await connection.db
        .collection<{ _id: string }>("lifecycle_documents")
        .insertOne({ _id: "a" }, { session });
      return "done";
    });

    expect(result).toBe("done");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.hasEnded).toBe(true);
    vi.restoreAllMocks();
  });

  it("a field left undefined is not stored: the document reads back as given", async () => {
    const documents = connection.client
      .db(connection.db.databaseName)
      .collection<{ _id: string; kept: number; left?: number }>("lifecycle_documents");

    await documents.insertOne({ _id: "u", kept: 1, left: undefined });

    const stored = await documents.findOne({ _id: "u" });
    expect(stored).toEqual({ _id: "u", kept: 1 });
    expect(stored).not.toHaveProperty("left");
  });
});

describe("the start checks the schema, and migrates it only when it was asked to", () => {
  it("by default a database that was never migrated is refused, and left as it was", async () => {
    const name = freshDatabaseName();
    const connection = new MongoConnection({ url: urlOnDatabase(REPLICA_SET_URL, name) });
    try {
      await expect(connection.onInit()).rejects.toThrow(MongoSchemaMissingError);

      const inspector = new MongoClient(REPLICA_SET_URL);
      try {
        expect(await inspector.db(name).listCollections().toArray()).toEqual([]);
      } finally {
        await inspector.close();
      }
    } finally {
      await connection.onDestroy();
      await dropDatabase(name);
    }
  });
});
