import {
  BudgetScope,
  CostLedgerRepository,
  Injectable,
  totalCost,
  type BudgetAccount,
  type BudgetLimit,
  type BudgetUsage,
  type CostCounter,
  type LedgerEntry,
} from "@agboss/core";
import { assertLedgerCutoff, assertLedgerEntries, StoreError } from "@agboss/core/stores";
import { usd } from "@agboss/core/units";
import type { AnyBulkWriteOperation, ClientSession, Collection } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";
import { prunedBeforeOf, raisedLedgerMark } from "../connection/ledger-mark.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import { idOf } from "./keys.js";

interface CounterDocument {
  _id: string;
  spentUsd: number;
  /** Input plus output tokens (#1318): what `maxTokens` counts. */
  tokens: number;
}

interface EntryDocument {
  _id: string;
  entry: true;
  /** When its spend was made (agbossjs/agboss#771); absent on an entry of before: never pruned. */
  madeAt?: Date;
}

/** The limits an execution last read for an account (#1318): either may be absent. */
interface LimitDocument {
  _id: string;
  maxSpendUsd?: number;
  maxTokens?: number;
}

const Held = z.object({ spentUsd: z.number(), tokens: z.number().optional() });
const Limit = z.object({ maxSpendUsd: z.number().optional(), maxTokens: z.number().optional() });

/** What a counter that was never written holds. */
const NO_USAGE: BudgetUsage = { spent: usd(0), tokens: 0 };

/** The scope as stored: one of `BudgetScope`'s values (anything else is refused). */
const scopeOf = (account: BudgetAccount): string => z.enum(BudgetScope).parse(account.scope);

const accountIdOf = (account: BudgetAccount): string =>
  idOf(account.budget, scopeOf(account), account.key);

const counterIdOf = (counter: CostCounter): string =>
  idOf(counter.budget, scopeOf(counter), counter.key, counter.period);

/** Which of two texts is first: -1, 0 or 1 (the counters' ids, which are distinct). */
export const compareStrings = (left: string, right: string): -1 | 0 | 1 =>
  left < right ? -1 : left > right ? 1 : 0;

/** The counters' order: by id. */
const byId = ([left]: readonly [string, number], [right]: readonly [string, number]): number =>
  compareStrings(left, right);

/** The counters' updates for a save of `cost`, one per counter, in one order. */
function countersOf(
  counters: readonly CostCounter[],
  added: { readonly cost: number; readonly tokens: number },
): AnyBulkWriteOperation<CounterDocument>[] {
  const times = new Map<string, number>();
  for (const counter of counters) {
    const id = counterIdOf(counter);
    times.set(id, (times.get(id) ?? 0) + 1);
  }
  // in one order, so two saves of overlapping counters meet on the same first document
  return [...times.entries()].sort(byId).map(([_id, count]) => ({
    updateOne: {
      filter: { _id },
      update: { $inc: { spentUsd: count * added.cost, tokens: count * added.tokens } },
      upsert: true,
    },
  }));
}

/**
 * `CostLedgerRepository` on MongoDB (agbossjs/agboss#483, #527): one document per counter — budget,
 * scope, scope key and period — so the instances of an application share a tenant's day. `saveAll`
 * adds the calls' cost to every counter it is given with `$inc` (a counter given twice counts twice),
 * all of them in **one transaction**: either every counter of the save counts it, or none does —
 * ledger entries only (agbossjs/agboss#817: anything else refused by `assertLedgerEntries` first),
 * each once by its `ledgerId`, its id upserted into `agboss_cost_entries` in that transaction
 * (agbossjs/agboss#727: a repeated save of the id adds nothing), dated by its `madeAt`; the pruning
 * mark — a document of that collection — is read in the same transaction, and an entry made before
 * it that is not held refuses the save (agbossjs/agboss#771); without the mark — seeded with the
 * collection, deleted by hand — a save and a prune fail closed with `MongoLedgerMarkMissingError`,
 * nothing added or deleted (agbossjs/agboss#798). Two
 * instances' concurrent saves on one counter conflict and the driver runs the loser's transaction
 * again — `$inc` of a committed attempt only, so nothing is lost or counted twice. No other locking:
 * as on PostgreSQL, the core accepts a small overrun of executions racing past one check (nothing is
 * reserved). A read is one `findOne` (`usd(0)` when none). The period is the core's, passed as text.
 */
@Injectable({ deps: [MongoConnection] })
export class MongoCostLedgerRepository extends CostLedgerRepository {
  constructor(private readonly connection: MongoConnection) {
    super();
  }

  get #counters(): Collection<CounterDocument> {
    return this.connection.db.collection<CounterDocument>(Collections.CostCounters);
  }

  get #entries(): Collection<EntryDocument> {
    return this.connection.db.collection<EntryDocument>(Collections.CostEntries);
  }

  get #limits(): Collection<LimitDocument> {
    return this.connection.db.collection<LimitDocument>(Collections.CostMaxSpend);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async findUsageByCounter(counter: CostCounter): Promise<BudgetUsage> {
    const found = await this.#counters.findOne({ _id: counterIdOf(counter) });
    if (found === null) return NO_USAGE;
    const held = Held.parse(found);
    return { spent: usd(held.spentUsd), tokens: held.tokens ?? 0 };
  }

  async saveAll(counters: readonly CostCounter[], entries: readonly LedgerEntry[]): Promise<void> {
    // a JS caller's record without an identity is refused before anything (agbossjs/agboss#817)
    assertLedgerEntries(entries);
    if (counters.length === 0 || entries.length === 0) return;
    await this.connection.inTransaction(async ({ session }) => {
      // the mark read in the transaction (agbossjs/agboss#771): a prune that removed an entry this
      // save holds in its snapshot conflicts with it, so the save runs again and reads the new mark
      const prunedBefore = await prunedBeforeOf(this.connection.db, session);
      const added = await this.#unrecordedEntriesOf(entries, prunedBefore, session);
      if (added.length === 0) return;
      await this.#counters.bulkWrite(
        countersOf(counters, {
          cost: totalCost(added),
          tokens: sum(added.map((entry) => entry.inputTokens + entry.outputTokens)),
        }),
        {
          session,
          ordered: true,
        },
      );
    });
  }

  /**
   * Of `entries`, what the save adds: each entry upserted now (agbossjs/agboss#727: a repeated id
   * adds nothing); an entry made before the mark is never inserted — held, it adds nothing; not
   * held, the save is refused (agbossjs/agboss#771).
   */
  async #unrecordedEntriesOf(
    entries: readonly LedgerEntry[],
    prunedBefore: Date,
    session: ClientSession,
  ): Promise<LedgerEntry[]> {
    const added: LedgerEntry[] = [];
    const expired: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const { ledgerId, madeAt } = entry;
      if (seen.has(ledgerId)) continue;
      seen.add(ledgerId);
      if (madeAt.getTime() < prunedBefore.getTime()) {
        if ((await this.#entries.findOne({ _id: ledgerId }, { session })) === null)
          expired.push(ledgerId);
      } else if (await this.#isNew(ledgerId, madeAt, session)) added.push(entry);
    }
    if (expired.length > 0)
      throw new StoreError.LedgerEntryExpired({ ledgerIds: expired, prunedBefore });
    return added;
  }

  /** Upserts the entry in `session`: whether this save inserted it. */
  async #isNew(ledgerId: string, madeAt: Date, session: ClientSession): Promise<boolean> {
    const written = await this.#entries.updateOne(
      { _id: ledgerId },
      { $setOnInsert: { entry: true, madeAt } },
      { session, upsert: true },
    );
    return written.upsertedCount === 1;
  }

  async deleteByMadeAtBefore(cutoff: Date): Promise<void> {
    // a cutoff that is no date would lower the mark: refused with the ledger's code,
    // store.ledger-cutoff-invalid (agbossjs/agboss#817, agbossjs/agboss#869)
    assertLedgerCutoff(cutoff);
    await this.connection.inTransaction(async ({ session }) => {
      // the mark raised (never lowered), then the entries made before it, in one transaction
      const prunedBefore = await raisedLedgerMark(this.connection.db, cutoff, session);
      await this.#entries.deleteMany({ madeAt: { $lt: prunedBefore } }, { session });
    });
  }

  async findLimitByAccount(account: BudgetAccount): Promise<BudgetLimit | undefined> {
    const found = await this.#limits.findOne({ _id: accountIdOf(account) });
    if (found === null) return undefined;
    const held = Limit.parse(found);
    return {
      ...(held.maxSpendUsd === undefined ? {} : { maxSpend: usd(held.maxSpendUsd) }),
      ...(held.maxTokens === undefined ? {} : { maxTokens: held.maxTokens }),
    };
  }

  /** Keeps the limits the execution read (the last one wins): a limit it has none of is cleared. */
  async saveLimit(account: BudgetAccount, limit: BudgetLimit): Promise<void> {
    await this.#limits.updateOne(
      { _id: accountIdOf(account) },
      {
        ...(limit.maxSpend === undefined && limit.maxTokens === undefined
          ? {}
          : {
              $set: {
                ...(limit.maxSpend === undefined ? {} : { maxSpendUsd: limit.maxSpend }),
                ...(limit.maxTokens === undefined ? {} : { maxTokens: limit.maxTokens }),
              },
            }),
        $unset: {
          ...(limit.maxSpend === undefined ? { maxSpendUsd: "" } : {}),
          ...(limit.maxTokens === undefined ? { maxTokens: "" } : {}),
        },
      },
      { upsert: true },
    );
  }
}

const sum = (values: readonly number[]): number => values.reduce((total, one) => total + one, 0);
