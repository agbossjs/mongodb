import {
  IdempotencyRunStatus,
  type ExecutionLease,
  type IdempotencyRunOutcome,
  type FencedEffectWork,
  type StoreClock,
} from "@agboss/core";
import { cancelFencedOf, type EffectKey } from "@agboss/core/stores";
import { withAmbientTransaction } from "../../src/connection/ambient.js";
import { cancelTreeOf, effectKeyIdentityOf, type ExecutionTree } from "@agboss/core/stores";
import type { Milliseconds } from "@agboss/core/units";
import type { ClientSession, Db } from "mongodb";
import {
  Collections,
  MongoExecutionLeaseRepository,
  MongoFencedEffectRepository,
  MongoOutboundCallRepository,
  type MongoConnection,
} from "../../src/index.js";
import { checkFence, lockKey } from "../../src/stores/fence.js";
import { idOf } from "../../src/stores/keys.js";
import { treeIdOf } from "../../src/stores/keys.js";
import {
  replayOf,
  resultDocumentOf,
  type ResultDocument,
} from "../../src/stores/fenced-effects/result-documents.js";
import type { LeaseDocument } from "../../src/stores/lease-documents.js";

/**
 * Broken cancel fences (agbossjs/agboss#909, #1117): each breaks one rule the contract and the
 * store's own tests state, and the sabotage run expects them red.
 */

/** How a broken fenced effect checks the tree's cancel, in the transaction after the lease check. */
export type CancelCheck = (db: Db, session: ClientSession, key: EffectKey) => Promise<void>;

const leasesOf = (db: Db) => db.collection<LeaseDocument>(Collections.ExecutionLeases);

const refuseIfMarked = async (key: EffectKey, marked: Promise<LeaseDocument | null>) => {
  if (!key.isCompensation && (await marked)?.cancelRequestedAt !== undefined)
    throw cancelFencedOf(key);
};

/** No cancel check at all: a cancelled tree's effects are written. */
export const noCheck: CancelCheck = () => Promise.resolve();

/**
 * The mark read, not locked: a plain read in the transaction's snapshot, no write to the root's
 * document — a cancel committed after the snapshot, or one that inserts the root's seed while a
 * child's transaction is open, is never seen and never waited for.
 */
export const readOnly: CancelCheck = (db, session, key) => {
  const tree = cancelTreeOf(key);
  return refuseIfMarked(
    key,
    leasesOf(db).findOne({ _id: treeIdOf(tree.tenantId, tree.rootExecutionId) }, { session }),
  );
};

/** The mark read outside the transaction (no session): the latest committed value, never locked. */
export const outsideTransaction: CancelCheck = (db, _session, key) => {
  const tree = cancelTreeOf(key);
  return refuseIfMarked(
    key,
    leasesOf(db).findOne({ _id: treeIdOf(tree.tenantId, tree.rootExecutionId) }),
  );
};

/** `MongoFencedEffectRepository` with the cancel check `check` in place of the package's. */
export class CancelCheckEffects extends MongoFencedEffectRepository {
  constructor(
    private readonly mongo: MongoConnection,
    private readonly seam: StoreClock,
    private readonly check: CancelCheck,
  ) {
    super(mongo, seam);
  }

  protected override runInTransaction<TResult>(
    key: EffectKey,
    work: FencedEffectWork<TResult>,
  ): Promise<IdempotencyRunOutcome<TResult>> {
    return this.mongo.inTransaction(async (transaction) => {
      const { db, session } = transaction;
      const now = this.seam.now();
      await checkFence(db, session, key, this.seam);
      const id = idOf(effectKeyIdentityOf(key));
      if (key.businessKey !== undefined)
        await lockKey(db, session, id, { now, expiresAt: key.expiresAt });
      const results = db.collection<ResultDocument>(Collections.FencedEffectResults);
      const stored = await results.findOne({ _id: id }, { session });
      if (stored !== null) return replayOf<TResult>(key, stored);
      await this.check(db, session, key);
      const text = this.storedResultOf(
        key,
        await withAmbientTransaction(this.mongo, transaction, async () => work()),
      );
      await results.insertOne(resultDocumentOf(key, text, now), { session });
      return {
        status: IdempotencyRunStatus.Ran,
        result: JSON.parse(text) as TResult,
        token: key.token,
      };
    });
  }
}

/** A cancel that answers and writes nothing. */
export class UnmarkedCancelLeases extends MongoExecutionLeaseRepository {
  override requestCancel(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * An `acquire` that replaces the document (what a `replaceOne` of the new lease does): the mark
 * the document carried is gone with the old fields.
 */
export class ReplacingAcquireLeases extends MongoExecutionLeaseRepository {
  constructor(
    private readonly mongo: MongoConnection,
    clock: StoreClock,
    application: ConstructorParameters<typeof MongoExecutionLeaseRepository>[2],
  ) {
    super(mongo, clock, application);
  }

  override async acquire(
    tenantId: string,
    rootExecutionId: string,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const taken = await super.acquire(tenantId, rootExecutionId, duration);
    if (taken !== undefined)
      await leasesOf(this.mongo.db).updateOne(
        { _id: treeIdOf(tenantId, rootExecutionId) },
        { $unset: { cancelRequestedAt: "" } },
      );
    return taken;
  }
}

/** A retention that lifts the marks older than its cutoff, by age alone (the rule #1117 removed). */
async function liftOld(db: Db, cutoff: Date): Promise<void> {
  await leasesOf(db).updateMany(
    { cancelRequestedAt: { $lt: cutoff } },
    { $unset: { cancelRequestedAt: "" } },
  );
}

/** The fenced effects' retention lifts the tree's old marks too. */
export class AgePruningEffects extends MongoFencedEffectRepository {
  constructor(
    private readonly mongo: MongoConnection,
    clock: StoreClock,
  ) {
    super(mongo, clock);
  }

  override async deleteExpired(now: Date): Promise<number> {
    const removed = await super.deleteExpired(now);
    await liftOld(this.mongo.db, now);
    return removed;
  }
}

/** The outbound calls' retention lifts the tree's old marks too. */
export class AgePruningCalls extends MongoOutboundCallRepository {
  constructor(
    private readonly mongo: MongoConnection,
    clock: StoreClock,
  ) {
    super(mongo, clock);
  }

  override async deleteExpired(now: Date): Promise<number> {
    const removed = await super.deleteExpired(now);
    await liftOld(this.mongo.db, now);
    return removed;
  }
}

/** A cancel before the first acquire seeds a lease at token 1: that acquire is token 2. */
export class SeedIsALeaseLeases extends MongoExecutionLeaseRepository {
  constructor(
    private readonly mongo: MongoConnection,
    private readonly seamClock: StoreClock,
    application: ConstructorParameters<typeof MongoExecutionLeaseRepository>[2],
  ) {
    super(mongo, seamClock, application);
  }

  override async requestCancel(tree: ExecutionTree): Promise<void> {
    await super.requestCancel(tree);
    await leasesOf(this.mongo.db).updateOne(
      { _id: treeIdOf(tree.tenantId, tree.rootExecutionId), token: 0 },
      { $set: { token: 1 } },
    );
  }
}
