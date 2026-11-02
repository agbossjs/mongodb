import {
  BudgetScope,
  CostLedgerRepository,
  Injectable,
  type BudgetAccount,
  type CostCounter,
  type UsageRecord,
} from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";
import type { AnyBulkWriteOperation, Collection } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import { idOf } from "./keys.js";

interface CounterDocument {
  _id: string;
  spentUsd: number;
}

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

/**
 * `CostLedgerRepository` on MongoDB (agbossjs/agboss#483, #527): one document per counter — budget,
 * scope, scope key and period — so the instances of an application share a tenant's day. `saveAll`
 * adds the calls' cost to every counter it is given with `$inc` (a counter given twice counts twice),
 * all of them in **one transaction**: either every counter of the save counts it, or none does. Two
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
    const cost = costOf(records);
    const times = new Map<string, number>();
    for (const counter of counters) {
      const id = counterIdOf(counter);
      times.set(id, (times.get(id) ?? 0) + 1);
    }
    // in one order, so two saves of overlapping counters meet on the same first document
    const operations: AnyBulkWriteOperation<CounterDocument>[] = [...times.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([_id, count]) => ({
        updateOne: { filter: { _id }, update: { $inc: { spentUsd: count * cost } }, upsert: true },
      }));
    await this.connection.inTransaction(async ({ session }) => {
      await this.#counters.bulkWrite(operations, { session, ordered: true });
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
