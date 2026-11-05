import { BudgetScope, type CostCounter, type UsageRecord } from "@agboss/core";
import { afterEach, describe, expect, it } from "vitest";
import { Collections, MongoCostLedgerRepository } from "../../src/index.js";
import { openConnection, testDatabase } from "../support/database.js";
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

/**
 * One database of its own for these cases (a fresh schema, so its mark is the seeded one), its
 * mark put back at the epoch after each case: a case deletes it by hand.
 */
const ledgerDatabase = testDatabase();

async function entriesCollection() {
  const connection = await openConnection(ledgerDatabase.url());
  const entries = connection.db.collection<LedgerDocument>(Collections.CostEntries);
  return { entries, close: () => connection.onDestroy() };
}

const markedLedger = (): MongoCostLedgerRepository =>
  new MongoCostLedgerRepository(connectionTo(ledgerDatabase.url()));

describe("MongoCostLedgerRepository: the pruning mark is never missing quietly (agbossjs/agboss#798)", () => {
  // after its first case, which reads the mark as the start seeded it
  afterEach(async () => {
    const { entries, close } = await entriesCollection();
    await entries.deleteOne({ _id: MARK_ID });
    await entries.insertOne({ _id: MARK_ID, prunedBefore: new Date(0) });
    await close();
  });

  it("a new database's ledger has its mark, at the epoch: nothing pruned yet", async () => {
    const { entries, close } = await entriesCollection();
    try {
      expect(await entries.findOne({ _id: MARK_ID })).toEqual({
        _id: MARK_ID,
        prunedBefore: new Date(0),
      });
    } finally {
      await close();
    }
  });

  it("the mark deleted after a prune: a pruned entry saved again is refused, never counted twice", async () => {
    const ledger = markedLedger();
    const { entries, close } = await entriesCollection();
    try {
      await ledger.saveAll([day("gone")], [entry("pass-m", 0)]);
      await ledger.deleteEntriesByMadeAtBefore(new Date(START + 1000));
      await entries.deleteOne({ _id: MARK_ID });

      await expect(ledger.saveAll([day("gone")], [entry("pass-m", 0)])).rejects.toMatchObject({
        code: "mongodb.ledger-mark-missing",
        name: "MongoLedgerMarkMissingError",
      });
      expect(await ledger.findSpentByCounter(day("gone"))).toBe(0.125);
    } finally {
      await close();
    }
  });

  it("without its mark a new entry adds nothing either, and a prune deletes nothing", async () => {
    const ledger = markedLedger();
    const { entries, close } = await entriesCollection();
    try {
      await ledger.saveAll([day("none")], [entry("pass-n", 0)]);
      await entries.deleteOne({ _id: MARK_ID });

      await expect(ledger.saveAll([day("none")], [entry("pass-n", 1)])).rejects.toMatchObject({
        code: "mongodb.ledger-mark-missing",
      });
      await expect(
        ledger.deleteEntriesByMadeAtBefore(new Date("2030-01-01T00:00:00.000Z")),
      ).rejects.toMatchObject({ code: "mongodb.ledger-mark-missing" });
      expect(await ledger.findSpentByCounter(day("none"))).toBe(0.125);
      expect(await entries.findOne({ _id: "pass-n:0" })).not.toBeNull();
      expect(await entries.findOne({ _id: MARK_ID })).toBeNull();
    } finally {
      await close();
    }
  });

  it("a restart does not seed a deleted mark again; the remedy in the message puts it back", async () => {
    const ledger = markedLedger();
    const { entries, close } = await entriesCollection();
    try {
      await ledger.saveAll([day("back")], [entry("pass-b", 0)]);
      await ledger.deleteEntriesByMadeAtBefore(new Date(START + 1000));
      await entries.deleteOne({ _id: MARK_ID });
      await (await openConnection(ledgerDatabase.url())).onDestroy();

      const refused = ledger.saveAll([day("back")], [entry("pass-b", 0)]);
      await expect(refused).rejects.toThrow(/insertOne\(\{ _id: "\\u0000pruned-before"/u);
      await entries.insertOne({ _id: MARK_ID, prunedBefore: new Date(START + 1000) });

      await expect(ledger.saveAll([day("back")], [entry("pass-b", 0)])).rejects.toMatchObject({
        code: "cost-ledger.entry-expired",
      });
      await ledger.saveAll([day("back")], [entry("pass-b", 1)]);
      expect(await ledger.findSpentByCounter(day("back"))).toBe(0.25);
    } finally {
      await close();
    }
  });
});
