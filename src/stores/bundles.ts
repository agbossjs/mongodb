import { MongoA2ADirectMessageRepository } from "./mongo-a2a-direct-message.repository.js";
import { MongoA2ATaskRepository } from "./mongo-a2a-task.repository.js";
import { MongoCheckpointSaver } from "./mongo-checkpoint-saver.js";
import { MongoChildExecutionQueueRepository } from "./mongo-child-execution-queue.repository.js";
import { MongoCostLedgerRepository } from "./mongo-cost-ledger.repository.js";
import { MongoExecutionAuditLogRepository } from "./mongo-execution-audit-log.repository.js";
import { MongoExecutionHistoryRepository } from "./mongo-execution-history.repository.js";
import { MongoExecutionLeaseRepository } from "./mongo-execution-lease.repository.js";
import { MongoExecutionRecordRepository } from "./mongo-execution-record.repository.js";
import { MongoExecutionTreeRepository } from "./mongo-execution-tree.repository.js";
import { MongoFencedEffectRepository } from "./mongo-fenced-effect.repository.js";
import { MongoMeshRequestRepository } from "./mongo-mesh-request.repository.js";
import { MongoOutboundCallRepository } from "./mongo-outbound-call.repository.js";
import { MongoPausedExecutionRepository } from "./mongo-paused-execution.repository.js";
import { MongoRateLimitRepository } from "./mongo-rate-limit.repository.js";

/**
 * The stores of `@agboss/mongodb` as lists to spread into `@Application({ providers })`
 * (agbossjs/agboss#891) — each class still listed by name, so `agboss describe` prints every one.
 */

/**
 * The durable stores: every store but the coordination ones (the leases, the child queue, the rate
 * limits) and the two that check the lease in their own transaction (the fenced effects, the
 * outbound calls) — what an application lists beside `@agboss/redis`'s
 * `REDIS_COORDINATION_STORES`, with `provide(EXECUTION_ID_STORE, MongoExecutionLeaseRepository)`
 * for the execution ids.
 */
export const MONGODB_DURABLE_STORES = [
  MongoExecutionRecordRepository,
  MongoPausedExecutionRepository,
  MongoCheckpointSaver,
  MongoExecutionTreeRepository,
  MongoExecutionAuditLogRepository,
  MongoCostLedgerRepository,
  MongoExecutionHistoryRepository,
  MongoMeshRequestRepository,
  MongoA2ATaskRepository,
  MongoA2ADirectMessageRepository,
] as const;

/** Every store of the package: a whole application on MongoDB alone. */
export const MONGODB_STORES = [
  MongoExecutionLeaseRepository,
  MongoChildExecutionQueueRepository,
  MongoRateLimitRepository,
  MongoFencedEffectRepository,
  MongoOutboundCallRepository,
  ...MONGODB_DURABLE_STORES,
] as const;
