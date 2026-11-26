/**
 * agbossjs/mongodb#103: the fenced effect store's edges that the shard's mutants dropped: the key is
 * checked before any command, every command of a call is in its transaction, a key with no business
 * key takes no lock and stores no fingerprint, the retention sweep removes what is older than its
 * cutoff and nothing newer, `hasCode` tells a server error by its code, ping.
 */
import {
  IdempotencyRunStatus,
  StoreClock,
  StoreTimeSource,
  type ExecutionLease,
} from "@agboss/core";
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { hours } from "@agboss/core/units";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Collections,
  MongoConnection,
  MongoExecutionLeaseRepository,
  MongoFencedEffectRepository,
} from "../../src/index.js";
import { replayOf, resultDocumentOf } from "../../src/stores/fenced-effects/result-documents.js";
import { HandClock } from "../contracts/lease-races.js";
import { instanceConnection } from "../contracts/mongodb-store.js";
import { TestApplicationContext } from "../support/application-context.js";
import { commandsOf, nameOf } from "../support/command-log.js";
import { emptyAll, testDatabase } from "../support/database.js";

vi.mock("mongodb", async (importOriginal) => {
  const { reportingCommands } = await import("../support/command-log.js");
  return reportingCommands(await importOriginal());
});

const database = testDatabase();
const TENANT = "default";

beforeEach(() => emptyAll(database.url()));

async function instance() {
  const clock = new HandClock();
  const store = new StoreClock(StoreTimeSource.Test, clock);
  const connection = await instanceConnection(database, "instance-1");
  const leases = new MongoExecutionLeaseRepository(
    connection,
    store,
    new TestApplicationContext("instance-1"),
  );
  const held = await leases.acquire(TENANT, "root-1", hours(1));
  if (held === undefined) throw new Error("the lease is held");
  return {
    clock,
    connection,
    held,
    effects: new MongoFencedEffectRepository(connection, store),
  };
}

const keyOf = (lease: ExecutionLease, name: string, extra = {}) =>
  effectKeyForTesting(
    {
      scopeKey: `${TENANT}:${lease.rootExecutionId}`,
      tenantId: TENANT,
      leaseExecutionId: lease.rootExecutionId,
      token: lease.token,
      idempotencyKey: `${lease.rootExecutionId}:charge:${name}`,
      name,
    },
    extra,
  );

describe("a fenced call", () => {
  it("is refused at the store's own entry for a key with no name, before any command (the core's runOnce checks it first, so the store's is reached by its transaction method)", async () => {
    const { connection, held } = await instance();
    class Open extends MongoFencedEffectRepository {
      enter(key: Parameters<MongoFencedEffectRepository["runOnce"]>[0]) {
        return this.runInTransaction(key, () => Promise.resolve({ ok: true }));
      }
    }
    const open = new Open(connection, new StoreClock(StoreTimeSource.Test, new HandClock()));
    const sent = commandsOf(connection);

    // the check throws at the call, before a promise is made; a call it lets through is awaited, so that none is left running
    const refused = async (key: Parameters<Open["enter"]>[0]): Promise<unknown> => {
      try {
        await open.enter(key);
      } catch (error) {
        return error;
      }
      return undefined;
    };

    expect(await refused(keyOf(held, ""))).toBeInstanceOf(Error);
    expect(await refused(keyOf(held, "keyed", { businessKey: "" }))).toBeInstanceOf(Error);
    expect(await refused(keyOf(held, "keyed", { businessKey: "order:42" }))).toBeInstanceOf(Error);

    expect(sent).toEqual([]);
  });

  it("sends every command inside its transaction, the read of a stored result and the insert of a new one too", async () => {
    const { connection, effects, held } = await instance();
    const sent = commandsOf(connection);

    const outcome = await effects.runOnce(keyOf(held, "one"), () => ({ receipt: "1" }));

    expect(outcome.status).toBe(IdempotencyRunStatus.Ran);
    const results = sent.filter((one) => one.collection === Collections.FencedEffectResults);
    expect(results.map(nameOf)).toEqual([
      `find ${Collections.FencedEffectResults}`,
      `insert ${Collections.FencedEffectResults}`,
    ]);
    expect(sent.every((one) => one.inTransaction)).toBe(true);
  });

  it("takes no business-key lock for a key with none, and a lock for a key with one", async () => {
    const { connection, effects, held } = await instance();
    const sent = commandsOf(connection);
    const locks = () => sent.filter((one) => one.collection === Collections.FencedKeyLocks);

    await effects.runOnce(keyOf(held, "plain"), () => ({ receipt: "1" }));
    expect(locks()).toEqual([]);

    await effects.runOnce(
      keyOf(held, "keyed", { businessKey: "order:42", fingerprint: "f-1" }),
      () => ({ receipt: "2" }),
    );
    expect(locks().length).toBeGreaterThan(0);
  });
});

describe("the stored result", () => {
  it("of a key with no business key has no fingerprint and no origin", async () => {
    const { connection, effects, held } = await instance();

    await effects.runOnce(keyOf(held, "plain"), () => ({ receipt: "1" }));

    const stored = await connection.db
      .collection(Collections.FencedEffectResults)
      .findOne({}, { projection: { _id: 0 } });
    expect(Object.keys(stored ?? {}).sort()).toEqual(["result", "storedAt", "token"]);
  });

  it("of a key with a business key and no origin has the fingerprint and no origin field", () => {
    const key = keyOf(
      { tenantId: TENANT, rootExecutionId: "r", holderInstanceId: "h", token: 1 } as ExecutionLease,
      "keyed",
      { businessKey: "order:42", fingerprint: "f-1" },
    );

    const document = resultDocumentOf(key, '{"ok":true}', new Date(0));

    expect(document).toMatchObject({ fingerprint: "f-1" });
    expect(document).not.toHaveProperty("origin");
  });

  it("a replay of a result with no origin names no step it was replayed from", () => {
    const lease = {
      tenantId: TENANT,
      rootExecutionId: "r",
      holderInstanceId: "h",
      token: 1,
    } as ExecutionLease;
    const key = keyOf(lease, "plain");

    const replayed = replayOf(key, { token: 1, result: '{"ok":true}' });

    expect(replayed).toMatchObject({ status: IdempotencyRunStatus.Replayed, token: 1 });
    expect(replayed).not.toHaveProperty("replayedFrom");
  });
});

describe("the retention sweep (agbossjs/agboss#1317: deleteExpired by each document's expiresAt)", () => {
  it("removes the results, the marks and the key locks whose expiry has come, keeps a later or a forever one, and counts them", async () => {
    const { connection, effects } = await instance();
    const past = new Date("2026-01-01T00:00:00.000Z");
    const future = new Date("2026-03-01T00:00:00.000Z");
    const now = new Date("2026-02-01T00:00:00.000Z");
    interface Expiring {
      _id: string;
      expiresAt: Date | null;
    }
    const results = connection.db.collection<Expiring>(Collections.FencedEffectResults);
    const marks = connection.db.collection<Expiring>(Collections.FencedEffectMarks);
    const locks = connection.db.collection<Expiring>(Collections.FencedKeyLocks);
    await results.insertMany([
      { _id: "r-old", expiresAt: past },
      { _id: "r-at", expiresAt: now },
      { _id: "r-new", expiresAt: future },
      { _id: "r-forever", expiresAt: null },
    ]);
    await marks.insertMany([
      { _id: "m-old", expiresAt: past },
      { _id: "m-new", expiresAt: future },
      { _id: "m-forever", expiresAt: null },
    ]);
    await locks.insertMany([
      { _id: "l-old", expiresAt: past },
      { _id: "l-new", expiresAt: future },
    ]);

    expect(await effects.deleteExpired(now)).toBe(4);

    const ids = async (collection: typeof results) =>
      (await collection.find({}).sort({ _id: 1 }).toArray()).map((one) => one._id);
    expect(await ids(results)).toEqual(["r-forever", "r-new"]);
    expect(await ids(marks)).toEqual(["m-forever", "m-new"]);
    expect(await ids(locks)).toEqual(["l-new"]);
  });
});

describe("ping", () => {
  it("answers on a server, and rejects on a deployment that does not answer", async () => {
    const { effects } = await instance();
    await expect(effects.ping()).resolves.toBeUndefined();

    const lost = new MongoConnection({
      url: "mongodb://127.0.0.1:1/?replicaSet=rs0&serverSelectionTimeoutMS=200",
    });
    try {
      const store = new MongoFencedEffectRepository(
        lost,
        new StoreClock(StoreTimeSource.Test, new HandClock()),
      );
      await expect(store.ping()).rejects.toThrow();
    } finally {
      await lost.onDestroy();
    }
  });
});
