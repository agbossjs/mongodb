import { BudgetScope, CostSource, type CostCounter, type LedgerEntry } from "@agboss/core";
import { usd } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { Collections, MongoCostLedgerRepository, type MongoConnection } from "../../src/index.js";
import { openConnection } from "../support/database.js";
import { mongoFaultTarget } from "./mongodb-target.js";

/**
 * agbossjs/agboss#832 — the fault suite's database, an operator's fault between two starts: a pod
 * saves and prunes, `agboss_cost_entries` is dropped, the next pod's start makes it again while
 * `agboss_cost_counters` holds the spend. A late pass that saves the pruned entry again (and one
 * counted before the drop) is refused — the spend is counted once — until the mark is put back,
 * through the pods' own direct connection to the primary.
 */
const target = mongoFaultTarget();

const counter: CostCounter = {
  budget: "tenant-daily-budget",
  scope: BudgetScope.Tenant,
  key: "fault-drop",
  period: "2026-10-18",
};

const START = Date.parse("2026-10-18T08:00:00.000Z");

const entry = (index: number): LedgerEntry => ({
  caller: "clerk-agent",
  model: "test/clerk",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: usd(0.125),
  costSource: CostSource.Api,
  ledgerId: `pass-fault:${String(index)}`,
  madeAt: new Date(START + index * 1000),
});

/** One pod's start on the fault database: a connection made and initialized, then `run`, then closed. */
async function onPod<T>(
  run: (ledger: MongoCostLedgerRepository, db: MongoConnection["db"]) => Promise<T>,
): Promise<T> {
  const connection = await openConnection(target.database.url);
  try {
    return await run(new MongoCostLedgerRepository(connection), connection.db);
  } finally {
    await connection.onDestroy();
  }
}

describe("agbossjs/agboss#832: a dropped ledger between two starts on the fault suite's database", () => {
  it("a pruned entry and a kept one saved again after the drop: refused, the spend counted once", async () => {
    const reset = target.database.reset;
    if (reset === undefined)
      throw new Error("the MongoDB fault target makes a database per scenario");
    await reset();
    await onPod(async (ledger) => {
      await ledger.saveAll([counter], [entry(0), entry(5)]);
      await ledger.deleteByMadeAtBefore(new Date(START + 1000));
    });
    await onPod(async (_, db) => {
      await db.collection(Collections.CostEntries).drop();
    });

    await onPod(async (ledger) => {
      for (const again of [entry(0), entry(5)])
        await expect(ledger.saveAll([counter], [again])).rejects.toMatchObject({
          code: "mongodb.ledger-mark-missing",
        });
      expect(await ledger.findSpentByCounter(counter)).toBe(0.25);
    });
  }, 120_000);
});
