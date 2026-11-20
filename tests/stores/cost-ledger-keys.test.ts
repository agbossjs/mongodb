/**
 * agbossjs/agboss#81: the keys of the ledger's Mongo statements that no mutant of Stryker drops (it
 * empties a whole literal, never removes one key), each proved by a test that fails without it.
 * The mark's filter names the mark by its `_id`: a document that only carries a `prunedBefore` is
 * no mark, and a prune that finds none fails closed; the creation of the ledger writes its
 * `recreatedAt` mark in its own transaction as it writes the other branch's.
 *
 * Keys left as they are, no test can tell them (the sweep's equivalents): `ordered: true` of the
 * counters' bulk write (the driver's own default, said, and one transaction either way);
 * `collation: { locale: "simple" }` of the ledger's `createCollection` (the server stores no
 * collation for the simple one: `options` is `{}` made either way); `w: "majority"` of its
 * transaction's concern (the driver's commit takes `w: "majority"` when the options name no `w`:
 * the commit's concern is `{ w: "majority", j: true }` either way, as
 * cost-ledger-mark.test.ts reads it).
 */
import { MongoClient, type Db } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collections, MongoCostLedgerRepository } from "../../src/index.js";
import { MongoLedgerMarkMissingError } from "../../src/errors.js";
import { createLedgerEntries, LEDGER_MARK_ID } from "../../src/connection/ledger-mark.js";
import { commandsOf, nameOf } from "../support/command-log.js";
import { dropDatabase, emptyAll, testDatabase } from "../support/database.js";
import { freshDatabaseName, REPLICA_SET_URL } from "../support/server.js";
import { connectionTo } from "../support/stores.js";

vi.mock("mongodb", async (importOriginal) => {
  const { reportingCommands } = await import("../support/command-log.js");
  return reportingCommands(await importOriginal());
});

const database = testDatabase();
const ENTRIES = Collections.CostEntries;
const EPOCH = new Date(0);
const CUTOFF = new Date("2026-10-18T08:00:10.000Z");

beforeEach(() => emptyAll(database.url()));

interface RawDoc {
  _id: string;
  prunedBefore?: Date | number;
  recreatedAt?: Date;
}

const raw = () => connectionTo(database.url()).db.collection<RawDoc>(ENTRIES);

describe("agbossjs/agboss#81: the mark is found by its id", () => {
  it.each([
    [
      "no mark, and a document that carries a date prunedBefore",
      undefined,
      { malformed: undefined },
    ],
    ["a mark that is no date, and a document that carries one", 0, { malformed: true }],
  ])("%s: the prune fails closed and raises nothing", async (_name, mark, expected) => {
    await raw().deleteOne({ _id: LEDGER_MARK_ID });
    if (mark !== undefined) await raw().insertOne({ _id: LEDGER_MARK_ID, prunedBefore: mark });
    await raw().insertOne({ _id: "decoy", prunedBefore: EPOCH });

    const refused: unknown = await new MongoCostLedgerRepository(connectionTo(database.url()))
      .deleteByMadeAtBefore(CUTOFF)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(MongoLedgerMarkMissingError);
    if (!(refused instanceof MongoLedgerMarkMissingError)) throw new Error("not the mark error");
    expect(refused.malformed).toBe(expected.malformed);
    expect(await raw().findOne({ _id: "decoy" })).toEqual({ _id: "decoy", prunedBefore: EPOCH });
  });
});

/** The creation of the ledger on a database no start has made: `run` with it, dropped after. */
async function onFreshDb(run: (client: MongoClient, db: Db) => Promise<void>): Promise<void> {
  const name = freshDatabaseName();
  const client = new MongoClient(REPLICA_SET_URL, {
    writeConcern: { w: 1 },
    monitorCommands: true,
  });
  try {
    await run(client, client.db(name));
  } finally {
    await client.close();
    await dropDatabase(name);
  }
}

describe("agbossjs/agboss#81: the ledger created over counters that hold spend", () => {
  it("writes the recreatedAt mark in the transaction that creates the collection", async () => {
    await onFreshDb(async (client, db) => {
      await db
        .collection<{ _id: string; spentUsd: number }>(Collections.CostCounters)
        .insertOne({ _id: "spent", spentUsd: 1 });
      const log = commandsOf({ client });

      await createLedgerEntries(db);

      expect(log.map(nameOf)).toEqual([`find ${Collections.CostCounters}`, `update ${ENTRIES}`]);
      expect(log.every((one) => one.inTransaction)).toBe(true);
      const marks = await db.collection<RawDoc>(ENTRIES).find().toArray();
      expect(marks).toHaveLength(1);
      expect(marks[0]).toMatchObject({ _id: LEDGER_MARK_ID });
      expect(marks[0]?.recreatedAt).toBeInstanceOf(Date);
      expect(marks[0]).not.toHaveProperty("prunedBefore");
    });
  });
});
