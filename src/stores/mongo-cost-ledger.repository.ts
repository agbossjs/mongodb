import {
  BudgetScope,
  CostLedgerEntryExpiredError,
  CostLedgerRepository,
  Injectable,
  type BudgetAccount,
  type CostCounter,
  type UsageRecord,
} from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";
import type { AnyBulkWriteOperation, ClientSession, Collection } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import { idOf } from "./keys.js";

interface CounterDocument {
  _id: string;
  spentUsd: number;
}

interface EntryDocument {
  _id: string;
  entry: true;
  /** When its spend was made (agbossjs/agboss#771); absent on an entry of before: never pruned. */
  madeAt?: Date;
}

/** The pruning mark (agbossjs/agboss#771): one document of the entries' collection. */
interface MarkDocument {
  _id: string;
  prunedBefore: Date;
}

/** The mark's `_id`: `\u0000` never occurs in a `ledgerId`. */
const MARK_ID = "\u0000pruned-before";

const Mark = z.object({ prunedBefore: z.date() });

interface MaxSpendDocument {
  _id: string;
  maxSpendUsd: number;
}

const Spent = z.object({ spentUsd: z.number() });
const MaxSpend = z.object({ maxSpendUsd: z.number() });

/** The scope as stored: one of `BudgetScope`'s values (anything else is refused). */
const scopeOf = (account: BudgetAccount): string => z.enum(BudgetScope).parse(account.scope);

const accountIdOf = (account: BudgetAccount): string =>
  idOf(account.budget, scopeOf(account), account.key);

const counterIdOf = (counter: CostCounter): string =>
  idOf(counter.budget, scopeOf(counter), counter.key, counter.period);

/** What the calls cost together, in USD. */
const costOf = (records: readonly UsageRecord[]): number =>
  records.reduce((sum, record) => sum + record.costUsd, 0);

/** The counters' updates for a save of `cost`, one per counter, in one order. */
function countersOf(
  counters: readonly CostCounter[],
  cost: number,
): AnyBulkWriteOperation<CounterDocument>[] {
  const times = new Map<string, number>();
  for (const counter of counters) {
    const id = counterIdOf(counter);
    times.set(id, (times.get(id) ?? 0) + 1);
  }
  // in one order, so two saves of overlapping counters meet on the same first document
  return [...times.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([_id, count]) => ({
      updateOne: { filter: { _id }, update: { $inc: { spentUsd: count * cost } }, upsert: true },
    }));
}

/**
 * `CostLedgerRepository` on MongoDB (agbossjs/agboss#483, #527): one document per counter — budget,
 * scope, scope key and period — so the instances of an application share a tenant's day. `saveAll`
 * adds the calls' cost to every counter it is given with `$inc` (a counter given twice counts twice),
 * all of them in **one transaction**: either every counter of the save counts it, or none does — a
 * record with a `ledgerId` once, its id upserted into `agboss_cost_entries` in that transaction
 * (agbossjs/agboss#727: a repeated save of the id adds nothing), dated by its `madeAt`; the pruning
 * mark — a document of that collection — is read in the same transaction, and an entry made before
 * it that is not held refuses the save (agbossjs/agboss#771). Two
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

  get #marks(): Collection<MarkDocument> {
    return this.connection.db.collection<MarkDocument>(Collections.CostEntries);
  }

  get #maxSpend(): Collection<MaxSpendDocument> {
    return this.connection.db.collection<MaxSpendDocument>(Collections.CostMaxSpend);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async findSpentByCounter(counter: CostCounter): Promise<Usd> {
    const found = await this.#counters.findOne({ _id: counterIdOf(counter) });
    return usd(found === null ? 0 : Spent.parse(found).spentUsd);
  }

  async saveAll(counters: readonly CostCounter[], records: readonly UsageRecord[]): Promise<void> {
    if (counters.length === 0 || records.length === 0) return;
    await this.connection.inTransaction(async ({ session }) => {
      // the mark read in the transaction (agbossjs/agboss#771): a prune that removed an entry this
      // save holds in its snapshot conflicts with it, so the save runs again and reads the new mark
      const prunedBefore = await this.#prunedBefore(session);
      const added = await this.#newEntriesOf(records, prunedBefore, session);
      if (added.length === 0) return;
      await this.#counters.bulkWrite(countersOf(counters, costOf(added)), {
        session,
        ordered: true,
      });
    });
  }

  /** The pruning mark in `session` (ms), `-Infinity` before the first prune. */
  async #prunedBefore(session: ClientSession): Promise<number> {
    const found = await this.#marks.findOne({ _id: MARK_ID }, { session });
    return found === null ? Number.NEGATIVE_INFINITY : Mark.parse(found).prunedBefore.getTime();
  }

  /**
   * Of `records`, what the save adds: each record without a `ledgerId`, and each entry upserted now
   * (agbossjs/agboss#727: a repeated id adds nothing); an entry made before the mark is never
   * inserted — held, it adds nothing; not held, the save is refused (agbossjs/agboss#771).
   */
  async #newEntriesOf(
    records: readonly UsageRecord[],
    prunedBefore: number,
    session: ClientSession,
  ): Promise<UsageRecord[]> {
    const added: UsageRecord[] = [];
    const expired: string[] = [];
    const seen = new Set<string>();
    for (const record of records) {
      const { ledgerId } = record;
      if (ledgerId === undefined) added.push(record);
      else if (!seen.has(ledgerId)) {
        seen.add(ledgerId);
        // an entry without a date is the oldest
        const madeAt = new Date(record.madeAt ?? 0);
        if (madeAt.getTime() < prunedBefore) {
          if ((await this.#entries.findOne({ _id: ledgerId }, { session })) === null)
            expired.push(ledgerId);
        } else if (await this.#isNew(ledgerId, madeAt, session)) added.push(record);
      }
    }
    if (expired.length > 0)
      throw new CostLedgerEntryExpiredError({
        ledgerIds: expired,
        prunedBefore: new Date(prunedBefore),
      });
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

  async deleteEntriesByMadeAtBefore(cutoff: Date): Promise<void> {
    await this.connection.inTransaction(async ({ session }) => {
      // the mark raised (never lowered), then the entries made before it, in one transaction
      const mark = await this.#marks.findOneAndUpdate(
        { _id: MARK_ID },
        { $max: { prunedBefore: cutoff } },
        { session, upsert: true, returnDocument: "after" },
      );
      const { prunedBefore } = Mark.parse(mark);
      await this.#entries.deleteMany({ madeAt: { $lt: prunedBefore } }, { session });
    });
  }

  async findMaxSpendByAccount(account: BudgetAccount): Promise<Usd | undefined> {
    const found = await this.#maxSpend.findOne({ _id: accountIdOf(account) });
    return found === null ? undefined : usd(MaxSpend.parse(found).maxSpendUsd);
  }

  async saveMaxSpend(account: BudgetAccount, maxSpend: Usd): Promise<void> {
    await this.#maxSpend.updateOne(
      { _id: accountIdOf(account) },
      { $set: { maxSpendUsd: maxSpend } },
      { upsert: true },
    );
  }
}
