/**
 * `MongoConnection` without a server: the driver parses the URL when the client is built and
 * connects on the first operation only, so every check made at construction — the URL's concerns,
 * the client's enforced ones, the settings — runs here. The start check against a real deployment
 * is in `tests/integration/`.
 */
import { describe, expect, it } from "vitest";
import {
  MongoConcernTooWeakError,
  MongoConnection,
  MongoSettingsError,
  TransactionReadConcern,
} from "../../src/index.js";
import { revealing, TestApplicationContext } from "../support/application-context.js";

/** What an operation on a deployment that does not answer rejects with. */
const MongoServerSelectionOrNetworkError = /ECONNREFUSED|Server selection timed out/;

const URL = "mongodb://db1:27017,db2:27017/?replicaSet=rs0";

/** The error `build` throws; fails the test when it throws none. */
function errorOf(build: () => unknown): unknown {
  try {
    build();
  } catch (error) {
    return error;
  }
  throw new Error("built: it should have failed");
}

describe("MongoConnection: one client per application instance", () => {
  it("is built from the application's environment, on the agboss database by default", async () => {
    const connection = new MongoConnection(
      new TestApplicationContext({ mongodbUrl: revealing(URL) }),
    );

    expect(connection.db.databaseName).toBe("agboss");
    await connection.onDestroy();
  });

  it("mongodbDatabase names the database", async () => {
    const connection = new MongoConnection(
      new TestApplicationContext({ mongodbUrl: revealing(URL), mongodbDatabase: "desk" }),
    );

    expect(connection.db.databaseName).toBe("desk");
    await connection.onDestroy();
  });

  it("is built from settings by a script or a test", async () => {
    const connection = new MongoConnection({ url: URL, database: "script" });

    expect(connection.db.databaseName).toBe("script");
    await connection.onDestroy();
  });

  it("its client writes with w=majority on the journal and reads at majority from the primary", async () => {
    const connection = new MongoConnection({ url: URL });

    expect(connection.client.writeConcern?.w).toBe("majority");
    expect(connection.client.writeConcern?.journal).toBe(true);
    expect(connection.client.readConcern?.level).toBe("majority");
    expect(connection.client.readPreference.mode).toBe("primary");
    expect(connection.db.writeConcern?.w).toBe("majority");
    await connection.onDestroy();
  });

  it("its transactions read one snapshot by default and commit with w=majority", async () => {
    const connection = new MongoConnection({ url: URL });

    expect(connection.transactionOptions).toEqual({
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority", journal: true },
      readPreference: "primary",
    });
    await connection.onDestroy();
  });

  it("mongodbTransactionReadConcern: majority reads majority-committed data in a transaction", async () => {
    const connection = new MongoConnection(
      new TestApplicationContext({
        mongodbUrl: revealing(URL),
        mongodbTransactionReadConcern: TransactionReadConcern.Majority,
      }),
    );

    expect(connection.transactionOptions.readConcern).toEqual({ level: "majority" });
    await connection.onDestroy();
  });

  it("w=majority, journal=true and readConcernLevel=majority in the URL are accepted", async () => {
    const connection = new MongoConnection({
      url: `${URL}&w=majority&journal=true&readConcernLevel=majority&readPreference=primary`,
    });

    expect(connection.client.writeConcern?.w).toBe("majority");
    await connection.onDestroy();
  });

  it("closing a client that never connected resolves", async () => {
    const connection = new MongoConnection({ url: URL });

    await expect(connection.onDestroy()).resolves.toBeUndefined();
  });
});

describe("MongoConnection refuses a URL that weakens a guarantee — never overrides it silently", () => {
  it.each([
    ["w=1", /write concern w=1: /],
    ["w=0", /write concern w=0: /],
    ["w=2", /write concern w=2: /],
    ["journal=false", /journal=false: /],
    ["readConcernLevel=local", /read concern local: /],
    ["readConcernLevel=available", /read concern available: /],
    ["readPreference=secondary", /read preference secondary: /],
    ["readPreference=nearest", /read preference nearest: /],
  ])("%s → MongoConcernTooWeakError", (option, problem) => {
    const error = errorOf(() => new MongoConnection({ url: `${URL}&${option}` }));

    expect(error).toBeInstanceOf(MongoConcernTooWeakError);
    expect(String(error)).toMatch(problem);
  });

  it("every weak option of the URL is named at once", () => {
    const error = errorOf(
      () => new MongoConnection({ url: `${URL}&w=1&journal=false&readConcernLevel=local` }),
    );

    if (!(error instanceof MongoConcernTooWeakError)) throw new Error("expected the named error");
    expect(error.problems).toHaveLength(3);
  });

  it("the environment's URL is checked the same way", () => {
    const error = errorOf(
      () =>
        new MongoConnection(new TestApplicationContext({ mongodbUrl: revealing(`${URL}&w=1`) })),
    );

    expect(error).toBeInstanceOf(MongoConcernTooWeakError);
  });
});

describe("MongoConnection: a URL the driver cannot use", () => {
  it.each([
    ["postgres://db:5432/app", /Invalid scheme/],
    ["mongodb://", /mongodbUrl is not a usable MongoDB connection string/],
    [`${URL}&w=`, /mongodbUrl is not a usable MongoDB connection string/],
  ])("%s → MongoSettingsError with the driver's reason", (url, message) => {
    const error = errorOf(() => new MongoConnection({ url }));

    expect(error).toBeInstanceOf(MongoSettingsError);
    expect(String(error)).toMatch(message);
  });

  it("the reason never prints the password", () => {
    const error = errorOf(() => new MongoConnection({ url: "mongodb://app:hunter2@/x" }));

    expect(error).toBeInstanceOf(MongoSettingsError);
    expect(String(error)).not.toMatch(/hunter2/);
  });

  it("an environment without mongodbUrl fails before any client is built", () => {
    expect(() => new MongoConnection(new TestApplicationContext({}))).toThrow(
      /mongodbUrl is missing/,
    );
  });
});

describe("MongoConnection when the deployment does not answer", () => {
  // port 1 on the loopback: nothing listens, the driver's server selection gives up quickly
  const UNREACHABLE = "mongodb://127.0.0.1:1/?replicaSet=rs0&serverSelectionTimeoutMS=200";

  it("the start check rejects: the application does not start on a deployment it cannot verify", async () => {
    const connection = new MongoConnection({ url: UNREACHABLE });
    try {
      await expect(connection.onInit()).rejects.toThrow(MongoServerSelectionOrNetworkError);
    } finally {
      await connection.onDestroy();
    }
  });

  it("ping rejects", async () => {
    const connection = new MongoConnection({ url: UNREACHABLE });
    try {
      await expect(connection.ping()).rejects.toThrow(MongoServerSelectionOrNetworkError);
    } finally {
      await connection.onDestroy();
    }
  });

  it("a transaction rejects without running a write, and its session is ended", async () => {
    const connection = new MongoConnection({ url: UNREACHABLE });
    const ran: string[] = [];
    try {
      const transaction = connection.inTransaction(async (session) => {
        ran.push("work");
        await connection.db.collection("payments").insertOne({ amount: 1 }, { session });
      });

      await expect(transaction).rejects.toThrow(MongoServerSelectionOrNetworkError);
      expect(ran).toEqual(["work"]);
    } finally {
      await connection.onDestroy();
    }
  });
});
