import { BudgetScope, type CostCounter, type UsageRecord } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { Collections, MongoCostLedgerRepository } from "../../src/index.js";
import { openConnection, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#771 on MongoDB, beyond the contract: lost answers retried on two instances while
 * a third prunes again and again count each entry once — the prune's transaction conflicts with a
 * save that holds an entry it removes — and an entry kept before #771 (no `madeAt`) is never
 * pruned and never counted again.
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
