// agbossjs/agboss#527 — the contract suites bite on MongoDB: deliberately broken stores run through
// storeConformance (in a vitest of its own, sabotage.test.ts), each with the rule it breaks.
import {
  ExecutionFencedError,
  FencedEffectSettings,
  FencedEffectStatus,
  type ExecutionLease,
  type EffectKey,
  type FencedEffectOutcome,
  type FencedEffectWork,
  StoreClock,
  StoreTimeSource,
} from "@agboss/core";
import { effectKeyIdentityOf } from "@agboss/core/stores";
import { storeConformance, type StoreInstanceContext } from "@agboss/core/testing/contracts";
import type { Milliseconds } from "@agboss/core/units";
import {
  Collections,
  MongoExecutionAuditLogRepository,
  MongoExecutionLeaseRepository,
  MongoFencedEffectRepository,
  MongoOutboundCallRepository,
  MongoPausedExecutionRepository,
  type MongoConnection,
  type MongoTransaction,
} from "../../../src/index.js";
import { checkCancel } from "../../../src/stores/cancel-fence.js";
import { lockKey } from "../../../src/stores/fence.js";
import {
  replayOf,
  resultDocumentOf,
  type ResultDocument,
} from "../../../src/stores/fenced-effects/result-documents.js";
import {
  DuplicateKeyNoticeOnce,
  ExtendAfterDeadline,
  ExtendWithoutCompare,
  MARKERS,
  NoDeadlineGuards,
  ReassignWithoutGuard,
  RenewRevivesAndShortens,
  RetentionIgnoresChain,
  ReversedOrder,
  ScansIgnoreAfter,
  StringHeadTime,
} from "../../stores/pause-sabotage.js";
import {
  AgePruningCalls,
  AgePruningEffects,
  CancelCheckEffects,
  ReplacingAcquireLeases,
  SeedIsALeaseLeases,
  UnmarkedCancelLeases,
  noCheck,
  type CancelCheck,
} from "../../stores/cancel-sabotage.js";
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
  token: number;
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
    private readonly seam: Pick<StoreInstanceContext, "storeClock" | "application" | "instanceId">,
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
      token: (stored?.token ?? 0) + 1,
      expiresAt: new Date(now.getTime() + lease),
      remaining: lease,
      ...(previous === undefined ? {} : { takenOverFrom: previous }),
    };
    await leases.updateOne(
      { _id },
      {
        $set: {
          ...{ tenantId, rootExecutionId, holderInstanceId: taken.holderInstanceId },
          ...{ token: taken.token, expiresAt: taken.expiresAt },
          ...{ released: false, yielded: false, superseded: false, finished: false },
          previousHolder: previous?.holderInstanceId ?? null,
          previousEpoch: previous?.token ?? null,
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
  lease.token === token &&
  lease.expiresAt.getTime() > now.getTime();

/** Whether a read lease is free to take at `now`: none, or not finished and released or expired. */
const isFree = (stored: Lease | null, now: Date): boolean =>
  stored === null ||
  (!stored.finished && (stored.released || stored.expiresAt.getTime() <= now.getTime()));

/** The holder a take of `stored` takes over from: one that ended without a release. */
const previousOf = (
  stored: Lease | null,
): { holderInstanceId: string; token: number } | undefined =>
  stored !== null && (!stored.released || stored.superseded)
    ? { holderInstanceId: stored.holderInstanceId, token: stored.token }
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
    private readonly seam: Pick<StoreInstanceContext, "storeClock">,
  ) {
    super(mongo, seam.storeClock, new FencedEffectSettings());
  }

  protected override runInTransaction<TResult>(
    key: EffectKey,
    work: FencedEffectWork<MongoTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    return this.mongo.inTransaction(async (transaction) => {
      const { db, session } = transaction;
      const now = this.seam.storeClock.now();
      const lease = await db
        .collection<Lease>(Collections.ExecutionLeases)
        .findOne({ _id: JSON.stringify([key.tenantId, key.leaseExecutionId]) }, { session });
      const refused = (observedToken?: number): ExecutionFencedError =>
        ExecutionFencedError.of({ scopeKey: key.scopeKey, token: key.token, observedToken });
      if (!isHeldAt(lease, key.token, now)) throw refused(lease?.token);
      const mark = await db
        .collection<{ _id: string; highestToken: number }>(Collections.FencedEffectMarks)
        .findOneAndUpdate(
          { _id: key.scopeKey },
          { $max: { highestToken: key.token }, $set: { storedAt: now } },
          { upsert: true, returnDocument: "after", session },
        );
      const highest = mark?.highestToken ?? 0;
      if (highest > key.token) throw refused(highest);
      const id = JSON.stringify([effectKeyIdentityOf(key)]);
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
  without: ["fencedEffect", "executionAuditLog"],
  interleavings: { depth: 4, walks: 20, walkDepth: 20 },
  stores: {
    executionLease: mongoStore(
      database,
      (connection, seam) =>
        new MongoExecutionLeaseRepository(
          connection,
          new StoreClock(StoreTimeSource.Test, seam.clock),
          seam.application,
        ),
    ),
    outboundCall: mongoStore(database, (connection, seam) => ({
      calls: new MongoOutboundCallRepository(
        connection,
        new StoreClock(StoreTimeSource.Test, seam.clock),
      ),
      leases: new MongoExecutionLeaseRepository(
        connection,
        new StoreClock(StoreTimeSource.Test, seam.clock),
        seam.application,
      ),
    })),
  },
});

// a take that checks, then writes: two owners of one free lease
storeConformance({
  name: "a check-then-write acquire",
  reset: () => emptyAll(database.url(), [CONTRACT_ROWS]),
  without: ["fencedEffect", "outboundCall", "executionAuditLog"],
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
    executionAuditLog: mongoStore(
      database,
      (connection) => new MongoExecutionAuditLogRepository(connection),
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

// #938: broken pause stores, each through the pause contract alone (a store set of one)
type PauseStore = new (
  ...args: ConstructorParameters<typeof MongoPausedExecutionRepository>
) => MongoPausedExecutionRepository;

const brokenPauseStores: readonly (readonly [string, PauseStore])[] = [
  ["a pause deadline left out of the compare-and-set", NoDeadlineGuards],
  ["pause notices written in the wrong order", ReversedOrder],
  ["a pause head time stored as a string", StringHeadTime],
  ["noticeOnce that relies on a duplicate-key error", DuplicateKeyNoticeOnce],
  // agbossjs/agboss#1064
  ["an extension decided by the stale read, not its deadline", ExtendWithoutCompare],
  ["an extension applied after the deadline", ExtendAfterDeadline],
  ["a notice claim renewed without its token holding", RenewRevivesAndShortens],
  ["pause scans that ignore their keyset", ScansIgnoreAfter],
  // agbossjs/agboss#946
  ["a reassignment whose write has no condition", ReassignWithoutGuard],
  [
    "a retention that removes a reassigned pause with its replacement stored",
    RetentionIgnoresChain,
  ],
];

for (const [name, Store] of brokenPauseStores)
  storeConformance({
    name,
    reset: () => emptyAll(database.url(), [CONTRACT_ROWS, MARKERS]),
    without: ["fencedEffect", "outboundCall"],
    interleavings: false,
    stores: {
      pausedExecution: mongoStore(
        database,
        (connection, seam) => new Store(connection, seam.clock),
      ),
    },
  });

/** A cancel check that is the package's own: the broken set leaves the check to its fence alone. */
const passes: CancelCheck = (db, session, key) => checkCancel(db, session, key);

/** The lease store of `broken`: its own, or the package's. */
const leasesOf = (
  broken: { readonly leases?: Leases },
  connection: MongoConnection,
  seam: StoreInstanceContext,
): MongoExecutionLeaseRepository =>
  new (broken.leases ?? MongoExecutionLeaseRepository)(
    connection,
    seam.storeClock,
    seam.application,
  );

// agbossjs/agboss#909, #1117: broken cancel fences, each through the lease, fenced-effect and
// outbound-call contracts and the explorer (the audit log has no part in a cancel)
type Leases = typeof MongoExecutionLeaseRepository;

interface BrokenCancel {
  readonly name: string;
  readonly leases?: Leases;
  readonly check?: CancelCheck;
  readonly agePruning?: true;
}

const brokenCancels: readonly BrokenCancel[] = [
  { name: "a cancel that is never written", leases: UnmarkedCancelLeases },
  { name: "a cancel check that is a no-op", check: noCheck },
  {
    name: "an acquire that replaces the lease document, the mark gone",
    leases: ReplacingAcquireLeases,
  },
  { name: "a retention that lifts a mark by its age", agePruning: true },
  { name: "a seed document that is a lease at token 1", leases: SeedIsALeaseLeases },
];

for (const broken of brokenCancels)
  storeConformance<MongoTransaction>({
    name: broken.name,
    reset: () => emptyAll(database.url(), [CONTRACT_ROWS]),
    without: ["executionAuditLog"],
    interleavings: { depth: 4, walks: 20, walkDepth: 16 },
    stores: {
      executionLease: mongoStore(database, (connection, seam) =>
        leasesOf(broken, connection, seam),
      ),
      fencedEffect: mongoStore(database, (connection, seam) => {
        const settings = new FencedEffectSettings();
        const effects = broken.agePruning
          ? new AgePruningEffects(connection, seam.storeClock, settings)
          : new CancelCheckEffects(connection, seam.storeClock, broken.check ?? passes, settings);
        return fencedEffectsOn(connection, seam, effects, leasesOf(broken, connection, seam));
      }),
      outboundCall: mongoStore(database, (connection, seam) => ({
        calls: broken.agePruning
          ? new AgePruningCalls(connection, seam.storeClock)
          : new MongoOutboundCallRepository(connection, seam.storeClock),
        leases: leasesOf(broken, connection, seam),
      })),
    },
  });
