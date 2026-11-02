/**
 * `@agboss/mongodb` (agbossjs/agboss#527): AGBoss's stores on a MongoDB replica set. One
 * `MongoClient` per application instance, `w=majority` on the journal, majority reads from the
 * primary, snapshot transactions, a standalone `mongod` refused; every store of the core's
 * contracts, held to `storeConformance` (agbossjs/agboss#526) and the fault suite (#484).
 */
export { MongoConnection } from "./connection/mongodb-connection.js";
export { Collections, type CollectionName } from "./connection/collections.js";
export type { MongoTransaction } from "./connection/transaction.js";
export { DEFAULT_DATABASE, type MongoConnectionSettings } from "./connection/settings.js";
export { TransactionReadConcern } from "./connection/concerns.js";
export { MongoTopology } from "./connection/deployment.js";
export {
  MongoCollationError,
  MongoConcernTooWeakError,
  MongoReplicaSetRequiredError,
  MongoSettingsError,
} from "./errors.js";
export { MongoExecutionLeaseRepository } from "./stores/mongo-execution-lease.repository.js";
export { MongoFencedEffectRepository } from "./stores/mongo-fenced-effect.repository.js";
export { MongoOutboundCallRepository } from "./stores/mongo-outbound-call.repository.js";
export { MongoExecutionLeaseEventRepository } from "./stores/mongo-execution-lease-event.repository.js";
export { MongoExecutionTreeRepository } from "./stores/mongo-execution-tree.repository.js";
export { MongoMeshRequestRepository } from "./stores/mongo-mesh-request.repository.js";
export { MongoCostLedgerRepository } from "./stores/mongo-cost-ledger.repository.js";
export { MongoExecutionHistoryRepository } from "./stores/mongo-execution-history.repository.js";
export { MongoChildExecutionQueueRepository } from "./stores/mongo-child-execution-queue.repository.js";
export { MongoRateLimitRepository } from "./stores/mongo-rate-limit.repository.js";
export { MongoPausedExecutionRepository } from "./stores/mongo-paused-execution.repository.js";
export { MongoExecutionRecordRepository } from "./stores/mongo-execution-record.repository.js";
export { MongoCheckpointSaver } from "./stores/mongo-checkpoint-saver.js";
