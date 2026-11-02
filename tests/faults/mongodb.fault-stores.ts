import type { Secret } from "@agboss/core";
import { secret } from "@agboss/core";
import type { FaultStores } from "@agboss/core/testing/faults";
import {
  MongoCheckpointSaver,
  MongoChildExecutionQueueRepository,
  MongoConnection,
  MongoCostLedgerRepository,
  MongoExecutionHistoryRepository,
  MongoExecutionLeaseEventRepository,
  MongoExecutionLeaseRepository,
  MongoExecutionRecordRepository,
  MongoExecutionTreeRepository,
  MongoFencedEffectRepository,
  MongoOutboundCallRepository,
  MongoPausedExecutionRepository,
  type MongoTransaction,
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

export const faultStores: FaultStores<MongoTransaction> = {
  providers: [
    MongoConnection,
    MongoCheckpointSaver,
    MongoChildExecutionQueueRepository,
    MongoCostLedgerRepository,
    MongoExecutionHistoryRepository,
    MongoExecutionLeaseEventRepository,
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
    insert: async ({ db, session }, row) => {
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
