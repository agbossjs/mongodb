/**
 * agbossjs/agboss#1213: the cost ledger's commands, read as the client sends them. A save is one
 * transaction — the mark, the entries' upserts and the counters' write all pass its session, the
 * counters ordered and in one order, nothing sent for what adds nothing — and a counter's scope is
 * checked before it names a document.
 */
import { BudgetScope, CostSource, type CostCounter, type LedgerEntry } from "@agboss/core";
import { usd } from "@agboss/core/units";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collections, MongoCostLedgerRepository } from "../../src/index.js";
import { LEDGER_MARK_ID } from "../../src/connection/ledger-mark.js";
import { idOf } from "../../src/stores/keys.js";
import { commandsOf, nameOf, type Sent } from "../support/command-log.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

vi.mock("mongodb", async (importOriginal) => {
  const { reportingCommands } = await import("../support/command-log.js");
  return reportingCommands(await importOriginal());
});

const database = testDatabase();
const ENTRIES = Collections.CostEntries;
const COUNTERS = Collections.CostCounters;
const START = Date.parse("2026-10-18T08:00:00.000Z");

beforeEach(() => emptyAll(database.url()));

const counter = (key: string): CostCounter => ({
  budget: "tenant-daily-budget",
  scope: BudgetScope.Tenant,
  key,
  period: "2026-10-18",
});

const entry = (ledgerId: string, index = 0): LedgerEntry => ({
  caller: "clerk-agent",
  model: "test/clerk",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: usd(0.125),
  costSource: CostSource.Api,
  ledgerId,
  madeAt: new Date(START + index * 1000),
});

/** A ledger whose commands are logged, and the log. */
function watched(): { ledger: MongoCostLedgerRepository; log: Sent[] } {
  const connection = connectionTo(database.url());
  return { ledger: new MongoCostLedgerRepository(connection), log: commandsOf(connection) };
}

interface RawDoc {
  _id: string;
  entry?: boolean;
  madeAt?: Date;
  prunedBefore?: Date;
}

const rawEntries = () => connectionTo(database.url()).db.collection<RawDoc>(ENTRIES);

describe("agbossjs/agboss#1213: the cost ledger's save", () => {
  it("reads the mark, upserts the entry and writes the counters, ordered, all in one transaction", async () => {
    const { ledger, log } = watched();

    await ledger.saveAll([counter("a")], [entry("p:0")]);

    expect(log.map(nameOf)).toEqual([`find ${ENTRIES}`, `update ${ENTRIES}`, `update ${COUNTERS}`]);
    expect(log.every((one) => one.inTransaction)).toBe(true);
    expect(log[2]?.command.ordered).toBe(true);
    expect(await rawEntries().findOne({ _id: "p:0" })).toEqual({
      _id: "p:0",
      entry: true,
      madeAt: entry("p:0").madeAt,
    });
  });

  it.each([
    ["descending", ["c", "b", "a"]],
    ["ascending", ["a", "b", "c"]],
    ["shuffled", ["b", "c", "a"]],
    ["shuffled the other way", ["c", "a", "b"]],
  ])("writes the counters in one order, whatever the order given: %s", async (_name, keys) => {
    const { ledger, log } = watched();

    await ledger.saveAll(keys.map(counter), [entry(`order-${keys.join("")}:0`)]);

    const updates = log.find((one) => nameOf(one) === `update ${COUNTERS}`)?.command.updates;
    const ids: unknown = (updates as { q: { _id: string } }[]).map((one) => one.q._id);
    expect(ids).toEqual(
      ["a", "b", "c"].map((key) => idOf("tenant-daily-budget", "tenant", key, "2026-10-18")),
    );
  });

  it("sends nothing for no entries or no counters", async () => {
    const { ledger, log } = watched();

    await ledger.saveAll([counter("a")], []);
    await ledger.saveAll([], [entry("none:0")]);

    expect(log).toEqual([]);
  });

  it("an entry already counted adds nothing: its counters are not written", async () => {
    const { ledger, log } = watched();
    await ledger.saveAll([counter("again")], [entry("again:0")]);
    log.length = 0;

    await ledger.saveAll([counter("again")], [entry("again:0")]);

    expect(log.map(nameOf)).toEqual([`find ${ENTRIES}`, `update ${ENTRIES}`]);
    expect(await ledger.findSpentByCounter(counter("again"))).toBe(0.125);
  });

  it("an entry given twice in one save is upserted once and counted once", async () => {
    const { ledger, log } = watched();

    await ledger.saveAll([counter("twice")], [entry("twice:0"), entry("twice:0")]);

    expect(log.map(nameOf)).toEqual([`find ${ENTRIES}`, `update ${ENTRIES}`, `update ${COUNTERS}`]);
    expect(await ledger.findSpentByCounter(counter("twice"))).toBe(0.125);
  });

  it("an entry made before the mark looks for its record in the transaction: held it adds nothing, else it is refused", async () => {
    const { ledger, log } = watched();
    const entries = rawEntries();
    await entries.replaceOne({ _id: LEDGER_MARK_ID }, { prunedBefore: new Date(START + 60_000) });
    await entries.insertOne({ _id: "held:0" });

    await ledger.saveAll([counter("old")], [entry("held:0")]);
    expect(log.map(nameOf)).toEqual([`find ${ENTRIES}`, `find ${ENTRIES}`]);
    expect(log.every((one) => one.inTransaction)).toBe(true);
    expect(await ledger.findSpentByCounter(counter("old"))).toBe(0);

    await expect(ledger.saveAll([counter("old")], [entry("lost:0")])).rejects.toMatchObject({
      code: "cost-ledger.entry-expired",
    });
  });

  it("a counter's scope is one of the scopes, before it names a document", async () => {
    const { ledger } = watched();
    const bogus = Object.assign(counter("bogus"), { scope: "no-such-scope" });

    await expect(ledger.findSpentByCounter(bogus)).rejects.toThrow();
    await expect(ledger.saveAll([bogus], [entry("bogus:0")])).rejects.toThrow();
    await expect(ledger.saveMaxSpend(bogus, usd(1))).rejects.toThrow();
    await expect(ledger.findMaxSpendByAccount(bogus)).rejects.toThrow();

    await ledger.saveAll([counter("named")], [entry("named:0")]);
    const stored = await connectionTo(database.url())
      .db.collection<{ _id: string }>(COUNTERS)
      .find()
      .toArray();
    expect(stored.map((one) => one._id)).toEqual([
      idOf("tenant-daily-budget", "tenant", "named", "2026-10-18"),
    ]);
  });
});
