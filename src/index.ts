/**
 * `@agboss/mongodb` (agbossjs/agboss#527): AGBoss's stores on a MongoDB replica set. One
 * `MongoClient` per application instance, `w=majority` on the journal, majority reads from the
 * primary, snapshot transactions, a standalone `mongod` refused, a versioned schema migrated
 * explicitly (`agboss-mongodb migrate`, `migrateMongodb`, agbossjs/agboss#891); every store of the core's
 * contracts, held to `storeConformance` (agbossjs/agboss#526) and the fault suite (#484).
 */
export { MongoConnection } from "./connection/mongodb-connection.js";
export { Collections, type CollectionName } from "./connection/collections.js";
export type { MongoTransaction } from "./connection/transaction.js";
export {
  DEFAULT_DATABASE,
  DEFAULT_WATCH_LIVENESS_SECONDS,
  type MongoConnectionSettings,
} from "./connection/settings.js";
export { MongoTransactionReadConcern } from "./connection/concerns.js";
export { MongoTopology } from "./connection/deployment.js";
// what the start does with the schema (agbossjs/agboss#891): the core's, shared with @agboss/postgres
export { SchemaSetup } from "@agboss/core/stores";
export {
  migrateMongodb,
  type MigrateMongodbOptions,
  type MongoAppliedMigrationReport,
  type MongoMigrationReport,
} from "./connection/migrate.js";
export {
  MongoCollationNotSimpleError,
  MongoDeploymentError,
  MongoDurabilityError,
  MongoLedgerMarkMissingError,
  MongoSchemaMissingError,
  MongoSchemaTooNewError,
  MongoSettingsError,
  type MongoCollationNotSimpleErrorOptions,
  type MongoDeploymentErrorOptions,
  type MongoDurabilityErrorOptions,
  type MongoLedgerMarkMissingErrorOptions,
  type MongoSettingsErrorOptions,
  type MongoSchemaMissingErrorOptions,
  type MongoSchemaTooNewErrorOptions,
} from "./errors.js";
export { MONGODB_DURABLE_STORES, MONGODB_STORES } from "./stores/bundles.js";
export { MongoExecutionLeaseRepository } from "./stores/mongo-execution-lease.repository.js";
export { MongoFencedEffectRepository } from "./stores/mongo-fenced-effect.repository.js";
export { MongoOutboundCallRepository } from "./stores/mongo-outbound-call.repository.js";
export { MongoExecutionAuditLogRepository } from "./stores/mongo-execution-audit-log.repository.js";
export { MongoExecutionTreeRepository } from "./stores/mongo-execution-tree.repository.js";
export { MongoMeshRequestRepository } from "./stores/mongo-mesh-request.repository.js";
export { MongoA2ATaskRepository } from "./stores/mongo-a2a-task.repository.js";
export { MongoA2ADirectMessageRepository } from "./stores/mongo-a2a-direct-message.repository.js";
export { MongoCostLedgerRepository } from "./stores/mongo-cost-ledger.repository.js";
export { MongoExecutionHistoryRepository } from "./stores/mongo-execution-history.repository.js";
export { MongoChildExecutionQueueRepository } from "./stores/mongo-child-execution-queue.repository.js";
export { MongoRateLimitRepository } from "./stores/mongo-rate-limit.repository.js";
export { MongoPausedExecutionRepository } from "./stores/mongo-paused-execution.repository.js";
export { MongoExecutionRecordRepository } from "./stores/mongo-execution-record.repository.js";
export { MongoCheckpointSaver } from "./stores/mongo-checkpoint-saver.js";
