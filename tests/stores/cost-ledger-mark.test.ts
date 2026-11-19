/**
 * agbossjs/agboss#1213: the ledger's pruning mark (`ledger-mark.ts`). A prune reads and raises it
 * in its transaction and names what it found when there is no date; the mark is created in one
 * transaction of majority, journaled writes; and a race of two creations — the collection there
 * (`NamespaceExists`, 48), the mark seeded in between (E11000) — is played by the database itself:
 * the command really done, then answered as the server answers the run that lost. Any other
 * failure fails closed.
 */
import {
  MongoClient,
  MongoServerError,
  type ClientSession,
  type Collection,
  type Db,
} from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collections, MongoCostLedgerRepository } from "../../src/index.js";
import { MongoLedgerMarkMissingError } from "../../src/errors.js";
import {
  createLedgerEntries,
  LEDGER_MARK_ID,
  seedLedgerMark,
} from "../../src/connection/ledger-mark.js";
import { commandsOf, nameOf } from "../support/command-log.js";
import { dropDatabase, emptyAll, testDatabase } from "../support/database.js";
import { freshDatabaseName, REPLICA_SET_URL } from "../support/server.js";
import { connectionTo } from "../support/stores.js";
import { BudgetScope, CostSource } from "@agboss/core";
import { usd } from "@agboss/core/units";

vi.mock("mongodb", async (importOriginal) => {
  const { reportingCommands } = await import("../support/command-log.js");
  return reportingCommands(await importOriginal());
});

const database = testDatabase();
const ENTRIES = Collections.CostEntries;
const EPOCH = new Date(0);
const CUTOFF = new Date("2026-10-18T08:00:10.000Z");

beforeEach(() => emptyAll(database.url()));

const serverError = (code: number): MongoServerError =>
  new MongoServerError({ code, errmsg: `the server's error ${String(code)}` });

function boundMember(target: object, key: string | symbol): unknown {
  const value: unknown = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
}

interface RawDoc {
  _id: string;
  prunedBefore?: Date | number;
  recreatedAt?: Date;
}

/** What a proxied `Db` does in place of the real command. */
interface Racing {
  createCollection?: (db: Db) => Promise<never>;
  insertOne?: (marks: Collection<RawDoc>) => Promise<never>;
  sessions?: ClientSession[];
}

/** `db` whose `createCollection` / mark `insertOne` is answered as `racing` says, its sessions kept. */
function racingDb(db: Db, racing: Racing): Db {
  const marksOf = (target: Collection<RawDoc>): Collection<RawDoc> =>
    new Proxy(target, {
      get(inner, key) {
        const { insertOne } = racing;
        if (key !== "insertOne" || insertOne === undefined) return boundMember(inner, key);
        return () => insertOne(inner);
      },
    });
  const clientOf = (client: MongoClient): MongoClient =>
    new Proxy(client, {
      get(inner, key) {
        if (key !== "startSession") return boundMember(inner, key);
        return () => {
          const session = inner.startSession();
          racing.sessions?.push(session);
          return session;
        };
      },
    });
  return new Proxy(db, {
    get(target, key) {
      const { createCollection } = racing;
      if (key === "client") return clientOf(target.client);
      if (key === "createCollection" && createCollection !== undefined)
        return () => createCollection(target);
      if (key !== "collection") return boundMember(target, key);
      return (...args: Parameters<Db["collection"]>) =>
        args[0] === ENTRIES
          ? marksOf(target.collection<RawDoc>(...args))
          : target.collection(...args);
    },
  });
}

const rawEntries = () => connectionTo(database.url()).db.collection<RawDoc>(ENTRIES);

const ledger = (): MongoCostLedgerRepository =>
  new MongoCostLedgerRepository(connectionTo(database.url()));

const counter = {
  budget: "tenant-daily-budget",
  scope: BudgetScope.Tenant,
  key: "marks",
  period: "2026-10-18",
};

const entry = (ledgerId: string) => ({
  caller: "clerk-agent",
  model: "test/clerk",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: usd(0.125),
  costSource: CostSource.Api,
  ledgerId,
  madeAt: new Date("2026-10-18T08:00:00.000Z"),
});

describe("agbossjs/agboss#1213: a prune and the mark", () => {
  it("raises the mark and deletes the entries before it, both in the transaction, nothing else sent", async () => {
    const connection = connectionTo(database.url());
    const log = commandsOf(connection);

    await new MongoCostLedgerRepository(connection).deleteByMadeAtBefore(CUTOFF);

    expect(log.map(nameOf)).toEqual([`findAndModify ${ENTRIES}`, `delete ${ENTRIES}`]);
    expect(log.every((one) => one.inTransaction)).toBe(true);
    expect(log[1]?.command.deletes[0].q).toEqual({ madeAt: { $lt: CUTOFF } });
  });

  it("a mark that is no date is read again in the transaction and refused as malformed", async () => {
    const connection = connectionTo(database.url());
    await rawEntries().replaceOne({ _id: LEDGER_MARK_ID }, { prunedBefore: 0 });
    const log = commandsOf(connection);

    const refused: unknown = await new MongoCostLedgerRepository(connection)
      .deleteByMadeAtBefore(CUTOFF)
      .catch((error: unknown) => error);

    expect(refused).toMatchObject({ code: "mongodb.ledger-mark-missing", malformed: true });
    expect(log.map(nameOf)).toEqual([`findAndModify ${ENTRIES}`, `find ${ENTRIES}`]);
    expect(log.every((one) => one.inTransaction)).toBe(true);
    expect(log[1]?.command.filter).toEqual({ _id: LEDGER_MARK_ID });
  });

  it("a mark deleted, entries still there: save and prune say it is missing, not malformed", async () => {
    await ledger().saveAll([counter], [entry("held:0")]);
    await rawEntries().deleteOne({ _id: LEDGER_MARK_ID });

    for (const refused of [
      await ledger()
        .saveAll([counter], [entry("held:1")])
        .catch((error: unknown) => error),
      await ledger()
        .deleteByMadeAtBefore(CUTOFF)
        .catch((error: unknown) => error),
    ]) {
      expect(refused).toBeInstanceOf(MongoLedgerMarkMissingError);
      expect(refused).toHaveProperty("code", "mongodb.ledger-mark-missing");
      if (!(refused instanceof MongoLedgerMarkMissingError)) throw new Error("not the mark error");
      expect(refused.malformed).toBeUndefined();
      expect(refused.recreatedAt).toBeUndefined();
      expect(refused.message).toContain("has no");
    }
  });

  it("a mark made again with the collection (recreatedAt) names that time, in a save and in a prune", async () => {
    const at = new Date("2026-10-18T07:00:00.000Z");
    await rawEntries().replaceOne({ _id: LEDGER_MARK_ID }, { recreatedAt: at });

    await expect(ledger().deleteByMadeAtBefore(CUTOFF)).rejects.toMatchObject({ recreatedAt: at });
    await expect(ledger().saveAll([counter], [entry("again:0")])).rejects.toMatchObject({
      recreatedAt: at,
    });
  });
});

describe("agbossjs/agboss#1213: the mark seeded", () => {
  it("seeds the epoch where there is none", async () => {
    await rawEntries().deleteOne({ _id: LEDGER_MARK_ID });

    await seedLedgerMark(connectionTo(database.url()).db);

    expect(await rawEntries().findOne({ _id: LEDGER_MARK_ID })).toEqual({
      _id: LEDGER_MARK_ID,
      prunedBefore: EPOCH,
    });
  });

  it("a mark there stays as it is: the duplicate key of the server, and of another instance's seed in between", async () => {
    const db = connectionTo(database.url()).db;
    await rawEntries().replaceOne({ _id: LEDGER_MARK_ID }, { prunedBefore: CUTOFF });

    await seedLedgerMark(db);
    await rawEntries().deleteOne({ _id: LEDGER_MARK_ID });
    await seedLedgerMark(
      racingDb(db, {
        insertOne: async (marks) => {
          await marks.insertOne({ _id: LEDGER_MARK_ID, prunedBefore: CUTOFF });
          throw serverError(11000);
        },
      }),
    );

    expect(await rawEntries().find({ _id: LEDGER_MARK_ID }).toArray()).toEqual([
      { _id: LEDGER_MARK_ID, prunedBefore: CUTOFF },
    ]);
  });

  it.each([
    ["a server error of another code", serverError(13)],
    ["the duplicate of the create (48)", serverError(48)],
    ["an error without a code", new Error("the connection was lost")],
  ])("fails closed on %s", async (_name, error) => {
    const db = connectionTo(database.url()).db;

    await expect(
      seedLedgerMark(racingDb(db, { insertOne: () => Promise.reject(error) })),
    ).rejects.toBe(error);
  });
});

/** The ledger's creation on a database no start has made: `run` with it, dropped after. */
async function onFreshDb(run: (client: MongoClient, db: Db) => Promise<void>): Promise<void> {
  const name = freshDatabaseName();
  // a client of w=1: the creation's own concern is what commits it
  const client = new MongoClient(REPLICA_SET_URL, { writeConcern: { w: 1 } });
  try {
    await run(client, client.db(name));
  } finally {
    await client.close();
    await dropDatabase(name);
  }
}

describe("agbossjs/agboss#1213: the ledger and its mark created", () => {
  it("looks for the counters in its transaction, projecting the id, and commits with majority and the journal", async () => {
    await onFreshDb(async (client, db) => {
      const log = commandsOf({ client });
      const commits: unknown[] = [];
      client.on("commandStarted", (event) => {
        if (event.commandName === "commitTransaction") commits.push(event.command.writeConcern);
      });

      await createLedgerEntries(db);

      expect(log.map(nameOf)).toEqual([`find ${Collections.CostCounters}`, `insert ${ENTRIES}`]);
      expect(log.every((one) => one.inTransaction)).toBe(true);
      expect(log[0]?.command.projection).toEqual({ _id: 1 });
      expect(commits).toHaveLength(1);
      expect(commits[0]).toMatchObject({ w: "majority", j: true });
      expect(await db.collection<RawDoc>(ENTRIES).find().toArray()).toEqual([
        { _id: LEDGER_MARK_ID, prunedBefore: EPOCH },
      ]);
    });
  });

  it("ends its session, made or refused", async () => {
    await onFreshDb(async (_client, db) => {
      const sessions: ClientSession[] = [];
      await createLedgerEntries(racingDb(db, { sessions }));
      const error = serverError(13);
      await expect(
        createLedgerEntries(
          racingDb(db, { sessions, createCollection: () => Promise.reject(error) }),
        ),
      ).rejects.toBe(error);

      expect(sessions.map((session) => session.hasEnded)).toEqual([true, true]);
    });
  });

  it("the collection made by another instance in between (NamespaceExists) is there as wanted", async () => {
    await onFreshDb(async (_client, db) => {
      await createLedgerEntries(
        racingDb(db, {
          createCollection: async (real) => {
            await real.createCollection(ENTRIES, { collation: { locale: "simple" } });
            await real
              .collection<RawDoc>(ENTRIES)
              .insertOne({ _id: LEDGER_MARK_ID, prunedBefore: EPOCH });
            throw serverError(48);
          },
        }),
      );

      expect(await db.collection<RawDoc>(ENTRIES).find().toArray()).toEqual([
        { _id: LEDGER_MARK_ID, prunedBefore: EPOCH },
      ]);
    });
  });

  it.each([
    ["a server error of another code", serverError(13)],
    ["a duplicate key (11000)", serverError(11000)],
    ["an error without a code", new Error("the connection was lost")],
  ])("fails closed on %s, the collection not made", async (_name, error) => {
    await onFreshDb(async (_client, db) => {
      await expect(
        createLedgerEntries(racingDb(db, { createCollection: () => Promise.reject(error) })),
      ).rejects.toBe(error);

      expect(await db.listCollections({ name: ENTRIES }).toArray()).toEqual([]);
    });
  });
});
