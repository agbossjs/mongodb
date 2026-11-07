import { BudgetScope, CostSource, type CostCounter, type LedgerEntry } from "@agboss/core";
import { usd } from "@agboss/core/units";
import { MongoClient } from "mongodb";
import { afterEach, describe, expect, it } from "vitest";
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

const entry = (pass: string, index: number): LedgerEntry => ({
  caller: "clerk-agent",
  model: "test/clerk",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: usd(0.125),
  costSource: CostSource.Api,
  ledgerId: `${pass}:${String(index)}`,
  madeAt: new Date(START + index * 1000),
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
        sweeper.deleteByMadeAtBefore(new Date(START + (step + 1) * 3000)),
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

    await ledger.deleteByMadeAtBefore(new Date("2030-01-01T00:00:00.000Z"));
    await ledger.saveAll([day("old")], [entry("pass-old", 0)]);

    expect(await ledger.findSpentByCounter(day("old"))).toBe(0);
  });
});

/** The mark's `_id` as an operator sees it in `agboss_cost_entries`. */
const MARK_ID = "\u0000pruned-before";

interface LedgerDocument {
  _id: string;
  /** A date as the ledger writes it; a number as an operator might, by mistake. */
  prunedBefore?: Date | number;
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
      await ledger.deleteByMadeAtBefore(new Date(START + 1000));
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
        ledger.deleteByMadeAtBefore(new Date("2030-01-01T00:00:00.000Z")),
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
      await ledger.deleteByMadeAtBefore(new Date(START + 1000));
      await entries.deleteOne({ _id: MARK_ID });
      await (await openConnection(ledgerDatabase.url())).onDestroy();

      const refused = ledger.saveAll([day("back")], [entry("pass-b", 0)]);
      await expect(refused).rejects.toThrow(/replaceOne\(\{ _id: "\\u0000pruned-before" \}/u);
      await entries.replaceOne(
        { _id: MARK_ID },
        { prunedBefore: new Date(START + 1000) },
        { upsert: true },
      );

      await expect(ledger.saveAll([day("back")], [entry("pass-b", 0)])).rejects.toMatchObject({
        code: "cost-ledger.entry-expired",
      });
      await ledger.saveAll([day("back")], [entry("pass-b", 1)]);
      expect(await ledger.findSpentByCounter(day("back"))).toBe(0.25);
    } finally {
      await close();
    }
  });

  it("a mark that is no date (an operator wrote ms): save and prune refuse it, the mark left as it is", async () => {
    const ledger = markedLedger();
    const { entries, close } = await entriesCollection();
    try {
      await entries.replaceOne({ _id: MARK_ID }, { prunedBefore: 0 });

      await expect(ledger.saveAll([day("ms")], [entry("pass-s", 0)])).rejects.toThrow(
        /has no date in prunedBefore/u,
      );
      await expect(ledger.deleteByMadeAtBefore(new Date(START + 1000))).rejects.toMatchObject({
        code: "mongodb.ledger-mark-missing",
      });
      expect(await entries.findOne({ _id: MARK_ID })).toEqual({ _id: MARK_ID, prunedBefore: 0 });
      expect(await ledger.findSpentByCounter(day("ms"))).toBe(0);
    } finally {
      await close();
    }
  });
});

/** A database no start has made yet: its URL, dropped after `run`. */
async function onFreshDatabase(run: (url: string) => Promise<void>): Promise<void> {
  const name = freshDatabaseName();
  try {
    await run(urlOnDatabase(REPLICA_SET_URL, name));
  } finally {
    await dropDatabase(name);
  }
}

describe("MongoCostLedgerRepository: the mark is made with its collection (agbossjs/agboss#798)", () => {
  it("three instances starting at once on a new database: one mark, and every one's save counts", async () => {
    await onFreshDatabase(async (url) => {
      const connections = await Promise.all([1, 2, 3].map(() => openConnection(url)));
      try {
        const ledgers = connections.map((connection) => new MongoCostLedgerRepository(connection));
        await Promise.all(
          ledgers.map((ledger, index) => ledger.saveAll([day("starts")], [entry("pass-c", index)])),
        );

        const marks = await connections[0]?.db
          .collection<LedgerDocument>(Collections.CostEntries)
          .find({ _id: MARK_ID })
          .toArray();
        expect(marks).toEqual([{ _id: MARK_ID, prunedBefore: new Date(0) }]);
        expect(await ledgers[0]?.findSpentByCounter(day("starts"))).toBe(0.375);
      } finally {
        for (const connection of connections) await connection.onDestroy();
      }
    });
  });

  it("a ledger collection there without its mark (made by hand): the start never seeds it, a save refuses", async () => {
    await onFreshDatabase(async (url) => {
      const client = new MongoClient(url);
      await client.db().createCollection(Collections.CostEntries);
      await client.close();
      const connection = await openConnection(url);
      try {
        const ledger = new MongoCostLedgerRepository(connection);
        await expect(ledger.saveAll([day("hand")], [entry("pass-h", 0)])).rejects.toMatchObject({
          code: "mongodb.ledger-mark-missing",
        });
      } finally {
        await connection.onDestroy();
      }
    });
  });
});

/** `agboss_cost_entries` dropped on `url`, as an operator would (`db.agboss_cost_entries.drop()`). */
async function dropLedgerEntries(url: string): Promise<void> {
  const client = new MongoClient(url);
  try {
    await client.db().collection(Collections.CostEntries).drop();
  } finally {
    await client.close();
  }
}

/** A start on `url` (a new connection's `onInit`: the schema made where it is missing), then closed. */
const restartOn = async (url: string): Promise<void> => (await openConnection(url)).onDestroy();

describe("MongoCostLedgerRepository: a dropped ledger is never made again as never pruned (agbossjs/agboss#832)", () => {
  it("dropped after a prune and made again by the next start: a pruned entry saved again is refused, never counted twice", async () => {
    await onFreshDatabase(async (url) => {
      const before = await openConnection(url);
      await new MongoCostLedgerRepository(before).saveAll([day("drop")], [entry("pass-d", 0)]);
      await new MongoCostLedgerRepository(before).deleteByMadeAtBefore(new Date(START + 1000));
      await before.onDestroy();
      await dropLedgerEntries(url);

      const connection = await openConnection(url);
      try {
        const ledger = new MongoCostLedgerRepository(connection);
        await expect(ledger.saveAll([day("drop")], [entry("pass-d", 0)])).rejects.toMatchObject({
          code: "mongodb.ledger-mark-missing",
          name: "MongoLedgerMarkMissingError",
        });
        await expect(ledger.saveAll([day("drop")], [entry("pass-d", 0)])).rejects.toThrow(
          /dropped and made again at .* while agboss_cost_counters held spend/u,
        );
        await expect(
          ledger.deleteByMadeAtBefore(new Date("2030-01-01T00:00:00.000Z")),
        ).rejects.toMatchObject({ code: "mongodb.ledger-mark-missing" });
        expect(await ledger.findSpentByCounter(day("drop"))).toBe(0.125);
      } finally {
        await connection.onDestroy();
      }
    });
  });

  it("the entries it kept are gone too: an entry counted before the drop and saved again is refused", async () => {
    await onFreshDatabase(async (url) => {
      const before = await openConnection(url);
      await new MongoCostLedgerRepository(before).saveAll([day("kept")], [entry("pass-k", 5)]);
      await before.onDestroy();
      await dropLedgerEntries(url);
      await restartOn(url);

      const connection = await openConnection(url);
      try {
        const ledger = new MongoCostLedgerRepository(connection);
        await expect(ledger.saveAll([day("kept")], [entry("pass-k", 5)])).rejects.toMatchObject({
          code: "mongodb.ledger-mark-missing",
        });
        expect(await ledger.findSpentByCounter(day("kept"))).toBe(0.125);
      } finally {
        await connection.onDestroy();
      }
    });
  });

  it("another restart never seeds it; the remedy in the message puts the mark back at the time it was made again", async () => {
    await onFreshDatabase(async (url) => {
      const before = await openConnection(url);
      await new MongoCostLedgerRepository(before).saveAll([day("cure")], [entry("pass-u", 0)]);
      await before.onDestroy();
      await dropLedgerEntries(url);
      await restartOn(url);
      await restartOn(url);

      const connection = await openConnection(url);
      try {
        const ledger = new MongoCostLedgerRepository(connection);
        const refusal: unknown = await ledger
          .saveAll([day("cure")], [entry("pass-u", 0)])
          .catch((error: unknown) => error);
        const at = /prunedBefore: new Date\("([^"]+)"\)/u.exec(String(refusal))?.[1];
        expect(at).toBeDefined();
        await connection.db
          .collection<LedgerDocument>(Collections.CostEntries)
          .replaceOne({ _id: MARK_ID }, { prunedBefore: new Date(at ?? "") });

        await expect(ledger.saveAll([day("cure")], [entry("pass-u", 0)])).rejects.toMatchObject({
          code: "cost-ledger.entry-expired",
        });
        const fresh: LedgerEntry = { ...entry("pass-u", 1), madeAt: new Date(Date.now() + 60_000) };
        await ledger.saveAll([day("cure")], [fresh]);
        expect(await ledger.findSpentByCounter(day("cure"))).toBe(0.25);
      } finally {
        await connection.onDestroy();
      }
    });
  });

  it("a new database, its counters collection there but empty: the mark at the epoch, as before", async () => {
    await onFreshDatabase(async (url) => {
      await restartOn(url);
      await dropLedgerEntries(url);
      await restartOn(url);

      const connection = await openConnection(url);
      try {
        const marks = await connection.db
          .collection<LedgerDocument>(Collections.CostEntries)
          .find({ _id: MARK_ID })
          .toArray();
        expect(marks).toEqual([{ _id: MARK_ID, prunedBefore: new Date(0) }]);
        const ledger = new MongoCostLedgerRepository(connection);
        await ledger.saveAll([day("new")], [entry("pass-f", 0)]);
        expect(await ledger.findSpentByCounter(day("new"))).toBe(0.125);
      } finally {
        await connection.onDestroy();
      }
    });
  });
});
