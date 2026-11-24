import {
  FencedEffectRepository,
  IdempotencyRunStatus,
  Injectable,
  StoreClock,
  type IdempotencyRunOutcome,
  type StoreDescriptor,
  type FencedEffectWork,
} from "@agboss/core";
import { effectKeyIdentityOf, type EffectKey } from "@agboss/core/stores";
import { withAmbientTransaction } from "../connection/ambient.js";
import type { ClientSession, Collection } from "mongodb";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import type { MongoTransaction } from "../connection/transaction.js";
import { checkCancel } from "./cancel-fence.js";
import { checkFence, lockKey } from "./fence.js";
import { idOf } from "./keys.js";
import { fencedOrderKeysOf, inLocalOrder } from "./local-order.js";
import {
  replayOf,
  resultDocumentOf,
  type ResultDocument,
} from "./fenced-effects/result-documents.js";
import { assertKeyAtEntry, previousIdOf } from "./key-entry.js";

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
@Injectable({ deps: [MongoConnection, StoreClock] })
export class MongoFencedEffectRepository extends FencedEffectRepository {
  /** One transactional backend with the other MongoDB stores (agbossjs/agboss#526). */
  static override readonly store: StoreDescriptor = { backend: "mongodb" };

  constructor(
    private readonly connection: MongoConnection,
    private readonly clock: StoreClock,
  ) {
    super();
  }

  get #results(): Collection<ResultDocument> {
    return this.connection.db.collection<ResultDocument>(Collections.FencedEffectResults);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  protected runInTransaction<TResult>(
    key: EffectKey,
    work: FencedEffectWork<TResult>,
  ): Promise<IdempotencyRunOutcome<TResult>> {
    // the key's name, business key and fingerprint decision (agbossjs/agboss#508, #538, #825)
    assertKeyAtEntry(key);
    // this instance's calls on one lease or business key commit in the order they were made
    return inLocalOrder(this, fencedOrderKeysOf(key, idOf(effectKeyIdentityOf(key))), () =>
      this.connection.inTransaction((transaction) =>
        // the work writes through `connection.requireTransaction()` — this transaction (#1317c)
        withAmbientTransaction(this.connection, transaction, () =>
          this.#effect(transaction, key, work),
        ),
      ),
    );
  }

  /**
   * Removes the results, marks and key locks whose `expiresAt` has come (`<= now`): three
   * `deleteMany`s, each atomic per document and none in a transaction — a backlog of any size is
   * removed, never aborted by the transaction's lifetime. A row with none (`Ttl.Forever`) is never
   * removed; a scope's mark keeps the latest expiry of its keys. A result removed before its mark, or
   * the other way round, changes nothing a fenced call decides. How many went.
   */
  async deleteExpired(now: Date): Promise<number> {
    const { db } = this.connection;
    const due = { expiresAt: { $type: "date", $lte: now } } as const;
    let removed = (await this.#results.deleteMany(due)).deletedCount;
    removed += (await db.collection(Collections.FencedEffectMarks).deleteMany(due)).deletedCount;
    removed += (await db.collection(Collections.FencedKeyLocks).deleteMany(due)).deletedCount;
    return removed;
  }

  /** The result stored under the key — or, after a rotation of the idempotency secret, under its previous digest. */
  async #storedOf(key: EffectKey, id: string, session: ClientSession): Promise<unknown> {
    const found = await this.#results.findOne({ _id: id }, { session });
    const previous = previousIdOf(key);
    return found !== null || previous === undefined
      ? found
      : this.#results.findOne({ _id: previous }, { session });
  }

  async #effect<TResult>(
    transaction: MongoTransaction,
    key: EffectKey,
    work: FencedEffectWork<TResult>,
  ): Promise<IdempotencyRunOutcome<TResult>> {
    const { db, session } = transaction;
    const now = this.clock.now();
    await checkFence(db, session, key, this.clock);
    const id = idOf(effectKeyIdentityOf(key));
    if (key.businessKey !== undefined)
      await lockKey(db, session, id, { now, expiresAt: key.expiresAt });
    const stored = await this.#storedOf(key, id, session);
    if (stored !== null) return replayOf(key, stored);
    // agbossjs/agboss#909, #1117: no stored result — a new effect after a durable cancel is refused
    await checkCancel(db, session, key);
    const text = this.storedResultOf(key, await work());
    // the lease's time runs on while the work does: checked again before the document is written
    await checkFence(db, session, key, this.clock);
    await this.#results.insertOne(resultDocumentOf(key, text, now), { session });
    return {
      status: IdempotencyRunStatus.Ran,
      // the result as a replay gives it: its JSON parsed
      result: JSON.parse(text) as TResult,
      token: key.token,
    };
  }
}
