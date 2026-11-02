import {
  ApplicationContext,
  ChildExecutionQueueRepository,
  Clock,
  ExecutionRecordStatus,
  Injectable,
  type ChildExecutionEnd,
  type QueuedChildExecution,
} from "@agboss/core";
import type { Collection } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import { DUPLICATE_KEY, hasCode, idOf } from "./keys.js";

/** One queued child: the contract's fields, `_id` its tenant and execution. */
interface QueuedDocument extends Omit<
  QueuedChildExecution,
  "instanceId" | "claimedAt" | "endedAt" | "failure"
> {
  _id: string;
  instanceId?: string;
  claimedAt?: Date;
  endedAt?: Date;
  failure?: string;
}

const Stored = z.object({
  tenantId: z.string(),
  executionId: z.string(),
  rootExecutionId: z.string(),
  parentExecutionId: z.string(),
  rootWorkflow: z.string(),
  workflow: z.string(),
  depth: z.number(),
  status: z.enum(ExecutionRecordStatus),
  run: z.string(),
  queuedAt: z.date(),
  instanceId: z.string().optional(),
  claimedAt: z.date().optional(),
  endedAt: z.date().optional(),
  failure: z.string().optional(),
});

/** A document as the contract gives it back. */
const childOf = (found: unknown): QueuedChildExecution => {
  const { instanceId, claimedAt, endedAt, failure, ...child } = Stored.parse(found);
  return { ...child, instanceId, claimedAt, endedAt, failure };
};

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
 * Times are the framework clock's.
 */
@Injectable({ deps: [MongoConnection, Clock, ApplicationContext] })
export class MongoChildExecutionQueueRepository extends ChildExecutionQueueRepository {
  constructor(
    private readonly connection: MongoConnection,
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
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
    try {
      await this.#queue.updateOne(
        { _id: idOf(tenantId, executionId), $or: again },
        { $set: queued, $unset: { instanceId: "", claimedAt: "", endedAt: "", failure: "" } },
        { upsert: true },
      );
      return true;
    } catch (error) {
      // queued already, or running under another claim: not this call's to queue
      if (hasCode(error, DUPLICATE_KEY)) return false;
      throw error;
    }
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
      { status: ExecutionRecordStatus.Queued },
      {
        $set: {
          status: ExecutionRecordStatus.Running,
          instanceId: this.applicationContext.instanceId,
          claimedAt: this.clock.now(),
        },
      },
      { sort: { depth: -1, queuedAt: 1 }, returnDocument: "after" },
    );
    return claimed === null ? undefined : childOf(claimed);
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
        ? { $set: { status: end.status, endedAt: this.clock.now() }, $unset: { failure: "" } }
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
}
