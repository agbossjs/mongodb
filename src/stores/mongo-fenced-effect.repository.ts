import {
  checkedBusinessKey,
  checkedEffectName,
  fencedKeyIdentityOf,
  FencedEffectRepository,
  FencedEffectSettings,
  FencedEffectStatus,
  Injectable,
  StoreClock,
  type Class,
  type FencedEffectKey,
  type FencedEffectOutcome,
  type FencedEffectWork,
} from "@agboss/core";
import type { Collection } from "mongodb";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import type { MongoTransaction } from "../connection/transaction.js";
import { checkFence, lockKey } from "./fence.js";
import { idOf } from "./keys.js";
import { fencedOrderKeysOf, inLocalOrder } from "./local-order.js";
import { MongoExecutionLeaseRepository } from "./mongo-execution-lease.repository.js";
import {
  replayOf,
  resultDocumentOf,
  type ResultDocument,
} from "./fenced-effects/result-documents.js";

/**
 * `FencedEffectRepository<MongoTransaction>` on MongoDB (#500, agbossjs/agboss#527): each scope's
 * mark and each effect's result beside `agboss_execution_leases`. One multi-document transaction
 * per call (`MongoConnection.inTransaction`: snapshot reads, `w=majority` commit), in the order of
 * #500: the key's name and business key (the core's checks, before any command), the lease
 * **locked by a write** and checked (held at the token, not released, live by the server's time —
 * else `ExecutionFencedError`), the scope's mark raised (`$max`; a higher one refuses), a business
 * key's identity locked (#508: no lease serializes its writers), the stored result (found →
 * `Replayed`), then the awaited `work(transaction)` and its result. Two instances on one key
 * conflict at the lease or the key's lock, before the work: the loser's transaction is run again by
 * the driver once the winner committed, and replays its result.
 *
 * Retries (`MongoConnection.inTransaction`): a transient error aborts the attempt and runs it again
 * — the work included, so a work does nothing outside `transaction.session`; its aborted writes are
 * never seen. A commit of unknown outcome is committed again, never run again. The business
 * documents must be written with `{ session: transaction.session }`: a write outside it is outside
 * the guarantee. Mind `transactionLifetimeLimitSeconds` (60 s by default): a long work aborts.
 * Listed with `MongoExecutionLeaseRepository`, whose leases it checks.
 */
@Injectable({ deps: [MongoConnection, StoreClock, FencedEffectSettings] })
export class MongoFencedEffectRepository extends FencedEffectRepository<MongoTransaction> {
  /** One transactional backend with the other MongoDB stores (agbossjs/agboss#526). */
  static override readonly backend: string | undefined = "mongodb";
  static override readonly leaseRepository: Class | undefined = MongoExecutionLeaseRepository;

  constructor(
    private readonly connection: MongoConnection,
    private readonly clock: StoreClock,
    settings: FencedEffectSettings,
  ) {
    super(settings);
  }

  get #results(): Collection<ResultDocument> {
    return this.connection.db.collection<ResultDocument>(Collections.FencedEffectResults);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  protected runInTransaction<TResult>(
    key: FencedEffectKey,
    work: FencedEffectWork<MongoTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    checkedEffectName(key.name);
    // a business key's text (agbossjs/agboss#538): refused by its rule before any command
    checkedBusinessKey(key);
    // this instance's calls on one lease or business key commit in the order they were made
    return inLocalOrder(this, fencedOrderKeysOf(key, idOf(fencedKeyIdentityOf(key))), () =>
      this.connection.inTransaction((transaction) => this.#effect(transaction, key, work)),
    );
  }

  async deleteByStoredAtBefore(cutoff: Date): Promise<void> {
    const { db } = this.connection;
    await this.connection.inTransaction(async ({ session }) => {
      const before = { $lt: cutoff };
      await this.#results.deleteMany({ storedAt: before }, { session });
      await db
        .collection(Collections.FencedEffectMarks)
        .deleteMany({ storedAt: before }, { session });
      await db.collection(Collections.FencedKeyLocks).deleteMany({ lockedAt: before }, { session });
    });
  }

  async #effect<TResult>(
    transaction: MongoTransaction,
    key: FencedEffectKey,
    work: FencedEffectWork<MongoTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    const { db, session } = transaction;
    const now = this.clock.now();
    await checkFence(db, session, key, this.clock);
    const id = idOf(fencedKeyIdentityOf(key));
    if (key.businessKey !== undefined) await lockKey(db, session, id, now);
    const stored = await this.#results.findOne({ _id: id }, { session });
    if (stored !== null) return replayOf(key, stored);
    const text = this.storedResultOf(key, await work(transaction));
    await this.#results.insertOne(resultDocumentOf(key, text, now), { session });
    return {
      status: FencedEffectStatus.Ran,
      // the result as a replay gives it: its JSON parsed
      result: JSON.parse(text) as TResult,
      token: key.token,
    };
  }
}
