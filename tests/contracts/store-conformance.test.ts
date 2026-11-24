import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { RecordingLogger } from "../support/recording-logger.js";
import { RandomIdGenerator } from "@agboss/core";
import { storeConformance, StoreCapability } from "@agboss/core/testing/contracts";
import { minutes } from "@agboss/core/units";
import {
  MongoCheckpointSaver,
  MongoChildExecutionQueueRepository,
  MongoCostLedgerRepository,
  MongoExecutionHistoryRepository,
  MongoExecutionAuditLogRepository,
  MongoExecutionLeaseRepository,
  MongoExecutionRecordRepository,
  MongoExecutionTreeRepository,
  MongoMeshRequestRepository,
  MongoA2ATaskRepository,
  MongoA2ADirectMessageRepository,
  MongoOutboundCallRepository,
  MongoPausedExecutionRepository,
  MongoRateLimitRepository,
} from "../../src/index.js";
import { SHARDS } from "../../scripts/mutation-shards.mjs";
import { emptyAll, testDatabase } from "../support/database.js";
import { CONTRACT_ROWS, fencedEffectsOn } from "./mongodb-sets.js";
import { mongoStore } from "./mongodb-store.js";

/**
 * Every MongoDB store through the core's `storeConformance` (agbossjs/agboss#526): the 15
 * published contract suites, each as `<contract> (MongoDB)`, and `store set (MongoDB)` — the three
 * fencing stores declare one backend. One database for the file, emptied before each case; each
 * instance on a client of its own. Nothing is left out (`without`). The interleaving explorer
 * (agbossjs/agboss#533) runs on the fencing stores too: `interleavings (MongoDB)`.
 */
const database = testDatabase();

/**
 * Under Stryker (`MUTATION_SHARD`), only the stores the shard names (`contracts` of
 * `scripts/mutation-shards.mjs`): a `testNamePattern` would override Stryker's per-test filter on every
 * mutant (agbossjs/mongodb#103); a run of the whole suite (the variable unset) is every store.
 */
const wantedStores = (): readonly string[] | undefined => {
  const name = process.env.MUTATION_SHARD;
  return name === undefined ? undefined : SHARDS[name]?.contracts;
};

function storesOfShard<TStores extends object>(stores: TStores): TStores {
  const wanted = wantedStores();
  if (wanted === undefined) return stores;
  return Object.fromEntries(
    Object.entries(stores).filter(([key]) => wanted.includes(key)),
  ) as TStores;
}

/** The fencing contracts a shard with a lease store leaves out (a set with leases alone says so). */
const FENCING_STORES = ["fencedEffect", "outboundCall", "executionAuditLog"] as const;
function leftOutOfShard(): readonly (typeof FENCING_STORES)[number][] {
  const wanted = wantedStores();
  if (!wanted?.includes("executionLease")) return [];
  return FENCING_STORES.filter((key) => !wanted.includes(key));
}

storeConformance({
  name: "MongoDB",
  without: leftOutOfShard(),
  // agbossjs/agboss#533, #590: every schedule of two instances 4 steps deep, 50 seeded walks of
  // three; a search out of its time limit fails with what it explored
  interleavings: { depth: 4, walks: 50, timeLimit: minutes(15) },
  reset: () => emptyAll(database.url(), [CONTRACT_ROWS]),
  stores: storesOfShard({
    // agbossjs/agboss#962: `latestByStep` is one indexed read, its ties by code point (#1115)
    checkpointSaver: {
      ...mongoStore<BaseCheckpointSaver>(
        database,
        (connection) => new MongoCheckpointSaver(connection),
      ),
      capabilities: [StoreCapability.LatestByStep],
    },
    // agbossjs/agboss#831: the queue has a watch (LISTEN / a change stream / pub/sub): declared
    childExecutionQueue: {
      ...mongoStore(
        database,
        (connection, seam) =>
          new MongoChildExecutionQueueRepository(
            connection,
            seam.clock,
            seam.application,
            new RecordingLogger(),
          ),
      ),
      capabilities: [StoreCapability.WatchQueued],
    },
    costLedger: mongoStore(database, (connection) => new MongoCostLedgerRepository(connection)),
    executionHistory: mongoStore(
      database,
      (connection) => new MongoExecutionHistoryRepository(connection),
    ),
    executionLease: mongoStore(
      database,
      (connection, seam) =>
        new MongoExecutionLeaseRepository(connection, seam.storeClock, seam.application),
    ),
    executionAuditLog: mongoStore(
      database,
      (connection) => new MongoExecutionAuditLogRepository(connection),
    ),
    executionRecord: mongoStore(
      database,
      (connection, seam) =>
        new MongoExecutionRecordRepository(
          connection,
          seam.clock,
          seam.application,
          new RandomIdGenerator(),
        ),
    ),
    executionTree: mongoStore(
      database,
      (connection) => new MongoExecutionTreeRepository(connection),
    ),
    fencedEffect: mongoStore(database, fencedEffectsOn),
    meshRequest: mongoStore(database, (connection) => new MongoMeshRequestRepository(connection)),
    // agbossjs/agboss#824: the A2A tasks, shared by the instances
    a2aTask: mongoStore(database, (connection) => new MongoA2ATaskRepository(connection)),
    // agbossjs/agboss#860: the direct replies, their ids claimed among the A2A tasks' messages
    a2aDirectMessage: mongoStore(database, (connection) => ({
      messages: new MongoA2ADirectMessageRepository(connection),
      tasks: new MongoA2ATaskRepository(connection),
    })),
    outboundCall: mongoStore(database, (connection, seam) => ({
      calls: new MongoOutboundCallRepository(connection, seam.storeClock),
      leases: new MongoExecutionLeaseRepository(connection, seam.storeClock, seam.application),
    })),
    pausedExecution: mongoStore(
      database,
      (connection, seam) => new MongoPausedExecutionRepository(connection, seam.clock),
    ),
    rateLimit: mongoStore(
      database,
      (connection, seam) => new MongoRateLimitRepository(connection, seam.clock, seam.application),
    ),
  }),
});
