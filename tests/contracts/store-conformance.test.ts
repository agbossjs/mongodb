import { RandomIdGenerator } from "@agboss/core";
import { storeConformance } from "@agboss/core/testing/contracts";
import {
  MongoCheckpointSaver,
  MongoChildExecutionQueueRepository,
  MongoCostLedgerRepository,
  MongoExecutionHistoryRepository,
  MongoExecutionLeaseEventRepository,
  MongoExecutionLeaseRepository,
  MongoExecutionRecordRepository,
  MongoExecutionTreeRepository,
  MongoMeshRequestRepository,
  MongoOutboundCallRepository,
  MongoPausedExecutionRepository,
  MongoRateLimitRepository,
  type MongoTransaction,
} from "../../src/index.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { CONTRACT_ROWS, fencedEffectsOn } from "./mongodb-sets.js";
import { mongoStore } from "./mongodb-store.js";

/**
 * Every MongoDB store through the core's `storeConformance` (agbossjs/agboss#526): the 13
 * published contract suites, each as `<contract> (MongoDB)`, and `store set (MongoDB)` — the three
 * fencing stores declare one backend. One database for the file, emptied before each case; each
 * instance on a client of its own. Nothing is left out (`without`). The interleaving explorer
 * (agbossjs/agboss#533) runs on the fencing stores too: `interleavings (MongoDB)`.
 */
const database = testDatabase();

storeConformance<MongoTransaction>({
  name: "MongoDB",
  // agbossjs/agboss#533, #590: every schedule of two instances 4 steps deep, 50 seeded walks of
  // three; a search out of its time limit fails with what it explored
  interleavings: { depth: 4, walks: 50, timeLimit: 900_000 },
  reset: () => emptyAll(database.url(), [CONTRACT_ROWS]),
  stores: {
    checkpointSaver: mongoStore(database, (connection) => new MongoCheckpointSaver(connection)),
    childExecutionQueue: mongoStore(
      database,
      (connection, seam) =>
        new MongoChildExecutionQueueRepository(connection, seam.clock, seam.application),
    ),
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
    executionLeaseEvent: mongoStore(
      database,
      (connection) => new MongoExecutionLeaseEventRepository(connection),
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
  },
});
