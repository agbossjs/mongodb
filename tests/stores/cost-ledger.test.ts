import { BudgetScope, type CostCounter, type UsageRecord } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { Collections, MongoCostLedgerRepository } from "../../src/index.js";
import { dropDatabase, openConnection, testDatabase, urlOnDatabase } from "../support/database.js";
import { freshDatabaseName, REPLICA_SET_URL } from "../support/server.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#771 on MongoDB, beyond the contract: lost answers retried on two instances while
 * a third prunes again and again count each entry once — the prune's transaction conflicts with a
 * save that holds an entry it removes — and an entry kept before #771 (no `madeAt`) is never
 * pruned and never counted again. agbossjs/agboss#798: the mark is seeded with the collection, and
 * without it a save or a prune fails closed — a pruned entry saved again is never counted twice.
 */
const database = testDatabase();

const ledgerOn = (): MongoCostLedgerRepository =>
  new MongoCostLedgerRepository(connectionTo(database.url()));

const day = (key: string): CostCounter => ({
  budget: "tenant-daily-budget",
  scope: BudgetScope.Tenant,
  key,
  period: "2026-10-18",
});

const START = Date.parse("2026-10-18T08:00:00.000Z");

const entry = (pass: string, index: number): UsageRecord => ({
  caller: "clerk-agent",
  model: "test/clerk",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.125,
  costSource: "api",
  ledgerId: `${pass}:${String(index)}`,
  madeAt: new Date(START + index * 1000).toISOString(),
});

describe("MongoCostLedgerRepository: pruning (agbossjs/agboss#771)", () => {
  it("lost answers retried on two instances while a third prunes again and again: each entry once", async () => {
    const [first, second, sweeper] = [ledgerOn(), ledgerOn(), ledgerOn()];
    const entries = Array.from({ length: 30 }, (_, index) => entry("pass-r", index));
    // every write landed; its answer was lost
    for (const record of entries) await first.saveAll([day("race")], [record]);

    const outcomes = await Promise.allSettled([
      ...entries.map((record, index) =>
        (index % 2 === 0 ? first : second).saveAll([day("race")], [record]),
      ),
      ...Array.from({ length: 10 }, (_, step) =>
        sweeper.deleteEntriesByMadeAtBefore(new Date(START + (step + 1) * 3000)),
      ),
    ]);

    for (const outcome of outcomes)
      if (outcome.status === "rejected")
        expect(outcome.reason).toMatchObject({ code: "cost-ledger.entry-expired" });
    expect(await first.findSpentByCounter(day("race"))).toBe(3.75);
  });

  it("an entry kept before #771 has no date: never pruned, saved again it adds nothing", async () => {
    const ledger = ledgerOn();
    const connection = await openConnection(database.url());
    await connection.db
      .collection<{ _id: string; entry: true }>(Collections.CostEntries)
      .insertOne({ _id: "pass-old:0", entry: true });
    await connection.onDestroy();

    await ledger.deleteEntriesByMadeAtBefore(new Date("2030-01-01T00:00:00.000Z"));
    await ledger.saveAll([day("old")], [entry("pass-old", 0)]);

    expect(await ledger.findSpentByCounter(day("old"))).toBe(0);
  });
});

/** The mark's `_id` as an operator sees it in `agboss_cost_entries`. */
const MARK_ID = "\u0000pruned-before";

interface LedgerDocument {
  _id: string;
  prunedBefore?: Date;
}

/** A database of its own (a fresh schema), its ledger and a way to reach its entries by hand. */
async function freshLedger() {
  const name = freshDatabaseName();
  const url = urlOnDatabase(REPLICA_SET_URL, name);
  const connection = await openConnection(url);
  const entries = connection.db.collection<LedgerDocument>(Collections.CostEntries);
  return {
    url,
    entries,
    ledger: new MongoCostLedgerRepository(connectionTo(url)),
    close: async () => {
      await connection.onDestroy();
      await dropDatabase(name);
    },
  };
}

describe("MongoCostLedgerRepository: the pruning mark is never missing quietly (agbossjs/agboss#798)", () => {
  it("a new database's ledger has its mark, at the epoch: nothing pruned yet", async () => {
    const fresh = await freshLedger();
    try {
      expect(await fresh.entries.findOne({ _id: MARK_ID })).toEqual({
        _id: MARK_ID,
        prunedBefore: new Date(0),
      });
    } finally {
      await fresh.close();
    }
  });

  it("the mark deleted after a prune: a pruned entry saved again is refused, never counted twice", async () => {
    const fresh = await freshLedger();
    try {
      await fresh.ledger.saveAll([day("gone")], [entry("pass-m", 0)]);
      await fresh.ledger.deleteEntriesByMadeAtBefore(new Date(START + 1000));
      await fresh.entries.deleteOne({ _id: MARK_ID });

      await expect(fresh.ledger.saveAll([day("gone")], [entry("pass-m", 0)])).rejects.toMatchObject(
        {
          code: "mongodb.ledger-mark-missing",
          name: "MongoLedgerMarkMissingError",
        },
      );
      expect(await fresh.ledger.findSpentByCounter(day("gone"))).toBe(0.125);
    } finally {
      await fresh.close();
    }
  });

  it("without its mark a new entry adds nothing either, and a prune deletes nothing", async () => {
    const fresh = await freshLedger();
    try {
      await fresh.ledger.saveAll([day("none")], [entry("pass-n", 0)]);
      await fresh.entries.deleteOne({ _id: MARK_ID });

      await expect(fresh.ledger.saveAll([day("none")], [entry("pass-n", 1)])).rejects.toMatchObject(
        { code: "mongodb.ledger-mark-missing" },
      );
      await expect(
        fresh.ledger.deleteEntriesByMadeAtBefore(new Date("2030-01-01T00:00:00.000Z")),
      ).rejects.toMatchObject({ code: "mongodb.ledger-mark-missing" });
      expect(await fresh.ledger.findSpentByCounter(day("none"))).toBe(0.125);
      expect(await fresh.entries.findOne({ _id: "pass-n:0" })).not.toBeNull();
      expect(await fresh.entries.findOne({ _id: MARK_ID })).toBeNull();
    } finally {
      await fresh.close();
    }
  });

  it("a restart does not seed a deleted mark again; the remedy in the message puts it back", async () => {
    const fresh = await freshLedger();
    try {
      await fresh.ledger.saveAll([day("back")], [entry("pass-b", 0)]);
      await fresh.ledger.deleteEntriesByMadeAtBefore(new Date(START + 1000));
      await fresh.entries.deleteOne({ _id: MARK_ID });
      await (await openConnection(fresh.url)).onDestroy();

      const refused = fresh.ledger.saveAll([day("back")], [entry("pass-b", 0)]);
      await expect(refused).rejects.toThrow(/insertOne\(\{ _id: "\\u0000pruned-before"/u);
      await fresh.entries.insertOne({ _id: MARK_ID, prunedBefore: new Date(START + 1000) });

      await expect(fresh.ledger.saveAll([day("back")], [entry("pass-b", 0)])).rejects.toMatchObject(
        { code: "cost-ledger.entry-expired" },
      );
      await fresh.ledger.saveAll([day("back")], [entry("pass-b", 1)]);
      expect(await fresh.ledger.findSpentByCounter(day("back"))).toBe(0.25);
    } finally {
      await fresh.close();
    }
  });
});
