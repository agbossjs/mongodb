import type { Secret } from "@agboss/core";
import { secret } from "@agboss/core";
import { FaultStoreTime, type FaultStoreSet } from "@agboss/core/testing/faults";
import {
  MongoA2ADirectMessageRepository,
  MongoA2ATaskRepository,
  MongoCheckpointSaver,
  MongoChildExecutionQueueRepository,
  MongoConnection,
  MongoCostLedgerRepository,
  MongoExecutionHistoryRepository,
  MongoExecutionAuditLogRepository,
  MongoExecutionLeaseRepository,
  MongoExecutionRecordRepository,
  MongoExecutionTreeRepository,
  MongoFencedEffectRepository,
  MongoOutboundCallRepository,
  MongoPausedExecutionRepository,
  requireMongoTransaction,
} from "../../src/index.js";

/**
 * agbossjs/agboss#484 — the MongoDB store set under the core's fault suite: every pod imports this
 * module (outside vitest: types only from `@agboss/core/testing/faults`) and lists every store of
 * the package on the scenario's database (`AGBOSS_FAULT_DATABASE_URL`: the replica set's primary,
 * a direct connection through the pod's proxy, the database in its path). The fixture's charge
 * writes its business document in the fenced effect's transaction, with its session.
 */

/** The environment the stores read: the deployment. */
export class MongoFaultEnvironment {
  mongodbUrl!: Secret;
}

/** The collection of the fixture's business documents. */
export const FAULT_BUSINESS_ROWS = "fault_business_rows";

export const faultStores: FaultStoreSet = {
  // agbossjs/agboss#799: the leases expire by the server's $$NOW, at the real rate — the fault suite
  // reads the history on it, whatever the pods' timeScale
  storeTime: FaultStoreTime.Database,
  // agbossjs/agboss#1017: `commitTransaction` is idempotent per transaction and the driver retries it
  // once: one reset after the COMMIT is answered by the retry (scenario 23: the charge lands once, no
  // hand-over); the retry's answer lost too is unknown (23b), read by `MongoConnection.inTransaction`
  resolvesCommitByRetry: true,
  providers: [
    MongoConnection,
    MongoA2ADirectMessageRepository,
    MongoA2ATaskRepository,
    MongoCheckpointSaver,
    MongoChildExecutionQueueRepository,
    MongoCostLedgerRepository,
    MongoExecutionHistoryRepository,
    MongoExecutionAuditLogRepository,
    MongoExecutionLeaseRepository,
    MongoExecutionRecordRepository,
    MongoExecutionTreeRepository,
    MongoFencedEffectRepository,
    MongoOutboundCallRepository,
    MongoPausedExecutionRepository,
  ],
  environment: {
    contract: MongoFaultEnvironment,
    values: { mongodbUrl: secret("AGBOSS_FAULT_DATABASE_URL") },
  },
  businessRows: {
    // the effect's ambient transaction (#1317c)
    insert: async (row) => {
      const { db, session } = requireMongoTransaction();
      await db.collection(FAULT_BUSINESS_ROWS).insertOne({ row }, { session });
    },
    committed: async (app) => {
      const found = await app
        .resolve(MongoConnection)
        .db.collection<{ row: string }>(FAULT_BUSINESS_ROWS)
        .find()
        .toArray();
      return found.map((one) => one.row);
    },
  },
};
