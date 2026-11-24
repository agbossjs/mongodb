import {
  ApplicationContext,
  ChildExecutionQueueRepository,
  ChildPlacement,
  Clock,
  ExecutionRecordStatus,
  Injectable,
  Logger,
  LogLevel,
  type ChildExecutionEnd,
  type ChildExecutionQueueCounts,
  type ChildExecutionQueueWatch,
  type QueuedChildExecution,
} from "@agboss/core";
import type { Collection } from "mongodb";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import { DUPLICATE_KEY, hasCode, idOf } from "./keys.js";
import {
  childOf,
  Depth,
  DEPTH,
  UNSET,
  type QueuedDocument,
} from "./child-queue/child-queue-documents.js";
import { MongoQueueWatch } from "./queue-watch.js";

/**
 * `ChildExecutionQueueRepository` on MongoDB (#333 PR 2, agbossjs/agboss#527): one document per
 * child queued with `ChildPlacement.AnyInstance`. Every operation is one single-document command:
 *
 * - `saveIfAbsent` is one upsert whose filter matches only a child that may be queued again — paused
 *   (resumed), or running under the claim the caller names (its worker lost its lease). A child
 *   there in any other state makes the insert a duplicate `_id`: `false`. Of two instances saving
 *   one child exactly one gets `true`.
 * - A claim is one `findOneAndUpdate` of the first queued child (the deepest, then the longest
 *   waiting): of two instances exactly one claims a child — the server runs the loser again on its
 *   write conflict, and it finds the next one.
 * - A completion is one update matching this instance's running child.
 *
 * - `watchQueued` is a change stream on the collection (agbossjs/agboss#777, `queue-watch.ts`):
 *   every document that becomes `queued` wakes the instance's claimers.
 *
 * Times are the framework clock's.
 */
@Injectable({ deps: [MongoConnection, Clock, ApplicationContext, Logger] })
export class MongoChildExecutionQueueRepository extends ChildExecutionQueueRepository {
  constructor(
    private readonly connection: MongoConnection,
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
    private readonly logger: Logger,
  ) {
    super();
  }

  get #queue(): Collection<QueuedDocument> {
    return this.connection.db.collection<QueuedDocument>(Collections.ChildExecutionQueue);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async saveIfAbsent(child: QueuedChildExecution): Promise<boolean> {
    const { tenantId, executionId, rootExecutionId, parentExecutionId, rootWorkflow } = child;
    const queued = {
      ...{ tenantId, executionId, rootExecutionId, parentExecutionId, rootWorkflow },
      ...{ workflow: child.workflow, depth: child.depth, run: child.run, queuedAt: child.queuedAt },
      status: ExecutionRecordStatus.Queued,
    };
    const again = [
      { status: ExecutionRecordStatus.Paused },
      ...(child.claimedAt === undefined
        ? []
        : [{ status: ExecutionRecordStatus.Running, claimedAt: child.claimedAt }]),
    ];
    // where it may run (#1286): kept as the save names it, a stale one of an earlier queueing cleared
    const placement = {
      placement: child.placement,
      excludeInstanceId: child.excludeInstanceId,
    };
    const unsetPlacement = Object.entries(placement).flatMap(([field, value]) =>
      value === undefined ? [[field, UNSET] as const] : [],
    );
    try {
      await this.#queue.updateOne(
        { _id: idOf(tenantId, executionId), $or: again },
        {
          $set: {
            ...queued,
            ...(child.placement === undefined ? {} : { placement: child.placement }),
            ...(child.excludeInstanceId === undefined
              ? {}
              : { excludeInstanceId: child.excludeInstanceId }),
          },
          $unset: {
            instanceId: UNSET,
            claimedAt: UNSET,
            endedAt: UNSET,
            failure: UNSET,
            ...Object.fromEntries(unsetPlacement),
          },
        },
        { upsert: true },
      );
      return true;
    } catch (error) {
      // queued already, or running under another claim: not this call's to queue
      if (hasCode(error, DUPLICATE_KEY)) return false;
      throw error;
    }
  }

  /**
   * Wakes `onQueued` whenever any instance queues a child (agbossjs/agboss#777). A connection that
   * dies silently is noticed within `mongodbWatchLivenessSeconds` (agbossjs/agboss#789): a warning
   * (`child-queue.watch-connection-lost`), a new stream and one wake-up.
   */
  override watchQueued(onQueued: () => void): Promise<ChildExecutionQueueWatch> {
    const warn = (message: string): void => {
      this.logger.write({
        level: LogLevel.Warn,
        code: "child-queue.watch-connection-lost",
        message,
        time: this.clock.now(),
      });
    };
    return MongoQueueWatch.open(this.connection, this.clock, warn, onQueued);
  }

  async findByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
  ): Promise<QueuedChildExecution | undefined> {
    const found = await this.#queue.findOne({ _id: idOf(tenantId, executionId) });
    return found === null ? undefined : childOf(found);
  }

  async claimFirstByStatusQueuedOrderByDepthDesc(): Promise<QueuedChildExecution | undefined> {
    const claimed = await this.#queue.findOneAndUpdate(
      {
        status: ExecutionRecordStatus.Queued,
        // what a general claim skips (#1286): an `IsolatedWorker` child (its own process claims it)
        // and a child this instance queued itself for `OtherWorker`
        placement: { $ne: ChildPlacement.IsolatedWorker },
        excludeInstanceId: { $ne: this.applicationContext.instanceId },
      },
      {
        $set: {
          status: ExecutionRecordStatus.Running,
          instanceId: this.applicationContext.instanceId,
          claimedAt: this.clock.now(),
        },
      },
      // the index by_claim (status, depth desc, queuedAt) already yields this order; the sort says it,
      // so that the order never depends on the plan: with no such index the claim is the same
      // (agbossjs/agboss#81, child-queue-keys.test.ts)
      { sort: { depth: -1, queuedAt: 1 }, returnDocument: "after" },
    );
    return claimed === null ? undefined : childOf(claimed);
  }

  /** The queued `IsolatedWorker` children, the deepest first, then the longest waiting. */
  async findQueuedIsolatedWorkerChildren(limit: number): Promise<readonly QueuedChildExecution[]> {
    const found = await this.#queue
      .find({ status: ExecutionRecordStatus.Queued, placement: ChildPlacement.IsolatedWorker })
      .sort({ depth: -1, queuedAt: 1 })
      .limit(limit)
      .toArray();
    return found.map(childOf);
  }

  /** The targeted claim: one child, `Queued` and `IsolatedWorker`, in one update. */
  async claimIsolatedWorkerByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
  ): Promise<QueuedChildExecution | undefined> {
    const claimed = await this.#queue.findOneAndUpdate(
      {
        _id: idOf(tenantId, executionId),
        status: ExecutionRecordStatus.Queued,
        placement: ChildPlacement.IsolatedWorker,
      },
      {
        $set: {
          status: ExecutionRecordStatus.Running,
          instanceId: this.applicationContext.instanceId,
          claimedAt: this.clock.now(),
        },
      },
      { returnDocument: "after" },
    );
    return claimed === null ? undefined : childOf(claimed);
  }

  /** Withdraws a child still `Queued`: a claim and a withdrawal of one document never both win. */
  async withdrawByTenantIdAndExecutionIdIfQueued(
    tenantId: string,
    executionId: string,
  ): Promise<boolean> {
    const removed = await this.#queue.deleteOne({
      _id: idOf(tenantId, executionId),
      status: ExecutionRecordStatus.Queued,
    });
    return removed.deletedCount === 1;
  }

  async completeByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
    end: ChildExecutionEnd,
  ): Promise<boolean> {
    const completed = await this.#queue.updateOne(
      {
        _id: idOf(tenantId, executionId),
        status: ExecutionRecordStatus.Running,
        instanceId: this.applicationContext.instanceId,
      },
      end.failure === undefined
        ? { $set: { status: end.status, endedAt: this.clock.now() }, $unset: { failure: UNSET } }
        : { $set: { status: end.status, endedAt: this.clock.now(), failure: end.failure } },
    );
    return completed.matchedCount === 1;
  }

  async deleteAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<void> {
    await this.#queue.deleteMany({ tenantId, rootExecutionId });
  }

  async countByStatus(): Promise<ChildExecutionQueueCounts> {
    const [found] = await this.#queue.aggregate(DEPTH).toArray();
    if (found === undefined) return { queued: 0, running: 0, oldestQueuedAt: undefined };
    const { queued, running, oldest } = Depth.parse(found);
    return { queued, running, oldestQueuedAt: oldest ?? undefined };
  }
}
