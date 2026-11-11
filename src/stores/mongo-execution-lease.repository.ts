import {
  ApplicationContext,
  ExecutionLeaseRepository,
  Injectable,
  StoreClock,
  type ExecutionIdentity,
  type ExecutionLease,
  type StoreDescriptor,
} from "@agboss/core";
import { remainingOf } from "@agboss/core/stores";
import type { Milliseconds } from "@agboss/core/units";
import type { Collection } from "mongodb";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import { DUPLICATE_KEY, hasCode, treeIdOf } from "./keys.js";
import {
  DROP_OLD_NAMES,
  heldBy,
  leaseOf,
  liveHeldBy,
  takeable,
  unleased,
  takePipeline,
  STORED_TOKEN,
  Yielded,
  type LeaseDocument,
} from "./lease-documents.js";
import { storeNowOf } from "./store-time.js";

/** One kept execution id (agbossjs/agboss#591): unique by `_id`, never removed. */
interface ExecutionIdDocument {
  _id: string;
  tenantId: string;
}

/**
 * `ExecutionLeaseRepository` on MongoDB (#265, agbossjs/agboss#527): one document per tree with its
 * latest lease, and every operation **one single-document command** — atomic by itself, no
 * transaction:
 *
 * - `acquire` is one conditional `findOneAndUpdate` of the tree's document — matched only when its
 *   lease is takeable: not finished (#520), released or expired by the store's time — and, when it
 *   matched none, one upsert that matches only a tree with no lease yet (MongoDB allows no `$expr`
 *   in an upsert's filter): a tree with a held or finished lease makes its insert a duplicate
 *   `_id`, refused. Each is atomic, and a lease document is never removed, so of two instances
 *   exactly one takes a free lease — the server runs the loser's update again on its write conflict
 *   and re-evaluates the filter on the winner's document. The replaced lease's holder is the new
 *   one's `takenOverFrom` (#501) when it expired without a release, or was closed by a check (#508).
 * - `renew`, `yield` and `reclaim` are one update matching the holder, the token, not released and
 *   live (`expiresAt > now`, #534); `release` and `retire` match the holder and the token.
 * - `claimExecutionId` (#591) is one insert into `agboss_execution_ids`: a duplicate `_id`
 *   is `false`.
 *
 * Time is the server's (agbossjs/agboss#533: `$$NOW`, bound once per command on the primary; a
 * test's clock as a literal when one is injected); `expiresAt = now + lease` in the same command,
 * so every take and renewal answers exactly `lease` left. Every write is acknowledged by a majority
 * on the journal, and retried exactly once by the driver when its reply is lost (retryable writes):
 * a failover never rolls an epoch back, and no call takes a lease twice.
 */
@Injectable({ deps: [MongoConnection, StoreClock, ApplicationContext] })
export class MongoExecutionLeaseRepository extends ExecutionLeaseRepository {
  /** One transactional backend with the other MongoDB stores (agbossjs/agboss#526). */
  static override readonly store: StoreDescriptor = { backend: "mongodb" };

  constructor(
    private readonly connection: MongoConnection,
    private readonly clock: StoreClock,
    private readonly applicationContext: ApplicationContext,
  ) {
    super();
  }

  get #leases(): Collection<LeaseDocument> {
    return this.connection.db.collection<LeaseDocument>(Collections.ExecutionLeases);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async claimExecutionId({ executionId, tenantId }: ExecutionIdentity): Promise<boolean> {
    try {
      await this.connection.db
        .collection<ExecutionIdDocument>(Collections.ExecutionIds)
        .insertOne({ _id: executionId, tenantId });
      return true;
    } catch (error) {
      if (hasCode(error, DUPLICATE_KEY)) return false;
      throw error;
    }
  }

  async acquire(
    tenantId: string,
    rootExecutionId: string,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const id = treeIdOf(tenantId, rootExecutionId);
    const now = storeNowOf(this.clock);
    const take = takePipeline(
      tenantId,
      rootExecutionId,
      this.applicationContext.instanceId,
      duration,
      now,
    );
    const key = { tenantId, rootExecutionId };
    // the tree's stored lease, taken over when it is takeable — one conditional update
    const taken = await this.#leases.findOneAndUpdate(takeable(id, now), take, {
      returnDocument: "after",
    });
    if (taken !== null) return leaseOf(taken, duration, key);
    try {
      // none taken over: the first lease of the tree, inserted unless a document is there
      const first = await this.#leases.findOneAndUpdate(unleased(id), take, {
        upsert: true,
        returnDocument: "after",
      });
      return first === null ? undefined : leaseOf(first, duration, key);
    } catch (error) {
      // the tree has a lease that is held by another, or finished: refused
      if (hasCode(error, DUPLICATE_KEY)) return undefined;
      throw error;
    }
  }

  async renew(held: ExecutionLease, duration: Milliseconds): Promise<Milliseconds | undefined> {
    const now = storeNowOf(this.clock);
    const renewed = await this.#leases.updateOne(liveHeldBy(held, now), [
      { $set: { token: STORED_TOKEN, expiresAt: { $add: [now, duration] } } },
      DROP_OLD_NAMES,
    ]);
    return renewed.matchedCount === 1 ? duration : undefined;
  }

  async release(held: ExecutionLease): Promise<void> {
    // a lease closed by a check stays `superseded`, a finished one `finished`: not written here
    await this.#leases.updateOne(heldBy(held), [
      { $set: { token: STORED_TOKEN, released: true } },
      DROP_OLD_NAMES,
    ]);
  }

  async retire(held: ExecutionLease): Promise<void> {
    await this.#leases.updateOne(heldBy(held), [
      { $set: { token: STORED_TOKEN, released: true, finished: true, yielded: false } },
      DROP_OLD_NAMES,
    ]);
  }

  async yield(held: ExecutionLease): Promise<Milliseconds | undefined> {
    const now = storeNowOf(this.clock);
    // the time left by the one command's time (`yieldedAt`), not extended: a yield is no renewal
    const yielded = await this.#leases.findOneAndUpdate(
      liveHeldBy(held, now),
      [{ $set: { token: STORED_TOKEN, yielded: true, yieldedAt: now } }, DROP_OLD_NAMES],
      { returnDocument: "after" },
    );
    if (yielded === null) return undefined;
    const { expiresAt, yieldedAt } = Yielded.parse(yielded);
    return remainingOf(expiresAt, yieldedAt);
  }

  async reclaim(held: ExecutionLease, duration: Milliseconds): Promise<ExecutionLease | undefined> {
    const now = storeNowOf(this.clock);
    const reclaimed = await this.#leases.findOneAndUpdate(
      liveHeldBy(held, now),
      [
        {
          $set: {
            token: { $add: [STORED_TOKEN, 1] },
            yielded: false,
            expiresAt: { $add: [now, duration] },
            previousHolder: null,
            previousToken: null,
          },
        },
        DROP_OLD_NAMES,
      ],
      { returnDocument: "after" },
    );
    return reclaimed === null ? undefined : leaseOf(reclaimed, duration, held);
  }
}
