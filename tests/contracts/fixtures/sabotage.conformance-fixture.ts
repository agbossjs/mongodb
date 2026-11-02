// agbossjs/agboss#527 — the contract suites bite on MongoDB: deliberately broken stores run through
// storeConformance (in a vitest of its own, sabotage.test.ts), each with the rule it breaks.
import {
  ExecutionFencedError,
  FencedEffectSettings,
  FencedEffectStatus,
  fencedKeyIdentityOf,
  type ExecutionLease,
  type FencedEffectKey,
  type FencedEffectOutcome,
  type FencedEffectWork,
} from "@agboss/core";
import { TestStoreClock } from "@agboss/core/testing";
import { storeConformance, type StoreSeam } from "@agboss/core/testing/contracts";
import type { Milliseconds } from "@agboss/core/units";
import {
  Collections,
  MongoExecutionLeaseEventRepository,
  MongoExecutionLeaseRepository,
  MongoFencedEffectRepository,
  MongoOutboundCallRepository,
  type MongoConnection,
  type MongoTransaction,
} from "../../../src/index.js";
import { lockKey } from "../../../src/stores/fence.js";
import {
  replayOf,
  resultDocumentOf,
  type ResultDocument,
} from "../../../src/stores/fenced-effects/result-documents.js";
import { TestApplicationContext } from "../../support/application-context.js";
import { emptyAll, testDatabase } from "../../support/database.js";
import { fenceRaceCases } from "../fence-races.js";
import { HandClock, leaseRaceCases } from "../lease-races.js";
import { instanceConnection } from "../mongodb-store.js";
import { CONTRACT_ROWS, fencedEffectsOn } from "../mongodb-sets.js";
import { mongoStore } from "../mongodb-store.js";

const database = testDatabase();

/** The lease document as a broken store reads it. */
interface Lease {
  _id: string;
  holderInstanceId: string;
  superseded: boolean;
  leaseEpoch: number;
  expiresAt: Date;
  released: boolean;
  finished: boolean;
}

/**
 * Check-then-write: `acquire` reads the tree's lease, decides in the code that it is free, then
 * writes the next epoch with an unconditional upsert — every other operation the package's. Two
 * instances can both decide "free": the lease races below give it two owners.
 */
class CheckThenWriteLeases extends MongoExecutionLeaseRepository {
  constructor(
    private readonly mongo: MongoConnection,
    private readonly seam: Pick<StoreSeam, "storeClock" | "application" | "instanceId">,
  ) {
    super(mongo, seam.storeClock, seam.application);
  }

  override async acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const leases = this.mongo.db.collection<Lease>(Collections.ExecutionLeases);
    const _id = JSON.stringify([tenantId, rootExecutionId]);
    const stored = await leases.findOne({ _id });
    const now = this.seam.storeClock.now();
    if (!isFree(stored, now)) return undefined;
    // the gap: another instance may decide "free" from the same read before this write lands
    const previous = previousOf(stored);
    const taken: ExecutionLease = {
      ...{ tenantId, rootExecutionId, holderInstanceId: this.seam.instanceId },
      leaseEpoch: (stored?.leaseEpoch ?? 0) + 1,
      expiresAt: new Date(now.getTime() + lease),
      remaining: lease,
      ...(previous === undefined ? {} : { takenOverFrom: previous }),
    };
    await leases.updateOne(
      { _id },
      {
        $set: {
          ...{ tenantId, rootExecutionId, holderInstanceId: taken.holderInstanceId },
          ...{ leaseEpoch: taken.leaseEpoch, expiresAt: taken.expiresAt },
          ...{ released: false, yielded: false, superseded: false, finished: false },
          previousHolder: previous?.holderInstanceId ?? null,
          previousEpoch: previous?.leaseEpoch ?? null,
        },
      },
      { upsert: true },
    );
    return taken;
  }
}

/** Whether a read lease is held at `token` and live at `now`. */
const isHeldAt = (lease: Lease | null, token: number, now: Date): boolean =>
  lease !== null &&
  !lease.released &&
  lease.leaseEpoch === token &&
  lease.expiresAt.getTime() > now.getTime();

/** Whether a read lease is free to take at `now`: none, or not finished and released or expired. */
const isFree = (stored: Lease | null, now: Date): boolean =>
  stored === null ||
  (!stored.finished && (stored.released || stored.expiresAt.getTime() <= now.getTime()));

/** The holder a take of `stored` takes over from: one that ended without a release. */
const previousOf = (
  stored: Lease | null,
): { holderInstanceId: string; leaseEpoch: number } | undefined =>
  stored !== null && (!stored.released || stored.superseded)
    ? { holderInstanceId: stored.holderInstanceId, leaseEpoch: stored.leaseEpoch }
    : undefined;

/**
 * The lease checked by a plain read inside the transaction — `findOne`, no write to the lease
 * document; everything else (the mark, the business key's lock, the replay, the result) as the
 * package's store does it. A read in a MongoDB transaction does not lock: a takeover committed
 * after the transaction's snapshot is not seen, and the zombie's write commits.
 */
class ReadOnlyFenceEffects extends MongoFencedEffectRepository {
  constructor(
    private readonly mongo: MongoConnection,
    private readonly seam: Pick<StoreSeam, "storeClock">,
  ) {
    super(mongo, seam.storeClock, new FencedEffectSettings());
  }

  protected override runInTransaction<TResult>(
    key: FencedEffectKey,
    work: FencedEffectWork<MongoTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    return this.mongo.inTransaction(async (transaction) => {
      const { db, session } = transaction;
      const now = this.seam.storeClock.now();
      const lease = await db
        .collection<Lease>(Collections.ExecutionLeases)
        .findOne({ _id: JSON.stringify([key.tenantId, key.leaseExecutionId]) }, { session });
      const refused = (observedToken?: number): ExecutionFencedError =>
        new ExecutionFencedError({ scopeKey: key.scopeKey, token: key.token, observedToken });
      if (!isHeldAt(lease, key.token, now)) throw refused(lease?.leaseEpoch);
      const mark = await db
        .collection<{ _id: string; highestToken: number }>(Collections.FencedEffectMarks)
        .findOneAndUpdate(
          { _id: key.scopeKey },
          { $max: { highestToken: key.token }, $set: { storedAt: now } },
          { upsert: true, returnDocument: "after", session },
        );
      const highest = mark?.highestToken ?? 0;
      if (highest > key.token) throw refused(highest);
      const id = JSON.stringify([fencedKeyIdentityOf(key)]);
      if (key.businessKey !== undefined) await lockKey(db, session, id, now);
      const results = db.collection<ResultDocument>(Collections.FencedEffectResults);
      const stored = await results.findOne({ _id: id }, { session });
      if (stored !== null) return replayOf<TResult>(key, stored);
      const text = this.storedResultOf(key, await work(transaction));
      await results.insertOne(resultDocumentOf(key, text, now), { session });
      return {
        status: FencedEffectStatus.Ran,
        result: JSON.parse(text) as TResult,
        token: key.token,
      };
    });
  }
}

// leases decided by the caller's own (skewed) clock instead of the server's: two live holders
storeConformance({
  name: "leases on the caller's clock",
  reset: () => emptyAll(database.url(), [CONTRACT_ROWS]),
  without: ["fencedEffect", "executionLeaseEvent"],
  interleavings: { depth: 4, walks: 20, walkDepth: 20 },
  stores: {
    executionLease: mongoStore(
      database,
      (connection, seam) =>
        new MongoExecutionLeaseRepository(
          connection,
          new TestStoreClock(seam.clock),
          seam.application,
        ),
    ),
    outboundCall: mongoStore(database, (connection, seam) => ({
      calls: new MongoOutboundCallRepository(connection, new TestStoreClock(seam.clock)),
      leases: new MongoExecutionLeaseRepository(
        connection,
        new TestStoreClock(seam.clock),
        seam.application,
      ),
    })),
  },
});

// a take that checks, then writes: two owners of one free lease
storeConformance({
  name: "a check-then-write acquire",
  reset: () => emptyAll(database.url(), [CONTRACT_ROWS]),
  without: ["fencedEffect", "outboundCall", "executionLeaseEvent"],
  interleavings: false,
  stores: {
    executionLease: mongoStore(
      database,
      (connection, seam) => new CheckThenWriteLeases(connection, seam),
    ),
  },
});

// a fenced effect whose lease check is a read: a zombie's write commits after the takeover
storeConformance<MongoTransaction>({
  name: "a fence check that only reads",
  reset: () => emptyAll(database.url(), [CONTRACT_ROWS]),
  interleavings: false,
  stores: {
    executionLease: mongoStore(
      database,
      (connection, seam) =>
        new MongoExecutionLeaseRepository(connection, seam.storeClock, seam.application),
    ),
    executionLeaseEvent: mongoStore(
      database,
      (connection) => new MongoExecutionLeaseEventRepository(connection),
    ),
    fencedEffect: mongoStore(database, (connection, seam) =>
      fencedEffectsOn(connection, seam, new ReadOnlyFenceEffects(connection, seam)),
    ),
    outboundCall: mongoStore(database, (connection, seam) => ({
      calls: new MongoOutboundCallRepository(connection, seam.storeClock),
      leases: new MongoExecutionLeaseRepository(connection, seam.storeClock, seam.application),
    })),
  },
});

// the take that checks, then writes, through the races the lease contract does not run
leaseRaceCases("a check-then-write acquire", async () => {
  await emptyAll(database.url(), [CONTRACT_ROWS]);
  const clock = new HandClock();
  const leasesOf = async (instanceId: string): Promise<CheckThenWriteLeases> =>
    new CheckThenWriteLeases(await instanceConnection(database, instanceId), {
      storeClock: clock,
      application: new TestApplicationContext({}, instanceId),
      instanceId,
    });
  return {
    first: await leasesOf("instance-1"),
    second: await leasesOf("instance-2"),
    advance: (by) => clock.advance(by),
  };
});

// the fence check that only reads, through the takeover inside its open transaction
fenceRaceCases("a fence check that only reads", async () => {
  await emptyAll(database.url(), ["fence_race_rows"]);
  const clock = new HandClock();
  const one = await instanceConnection(database, "instance-1");
  const two = await instanceConnection(database, "instance-2");
  const application = (instanceId: string): TestApplicationContext =>
    new TestApplicationContext({}, instanceId);
  return {
    first: {
      effects: new ReadOnlyFenceEffects(one, { storeClock: clock }),
      leases: new MongoExecutionLeaseRepository(one, clock, application("instance-1")),
    },
    second: { leases: new MongoExecutionLeaseRepository(two, clock, application("instance-2")) },
    advance: (by) => clock.advance(by),
    committed: () => two.db.collection("fence_race_rows").countDocuments(),
  };
});
