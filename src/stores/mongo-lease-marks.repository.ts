import {
  ApplicationContext,
  ExecutionLeaseRepository,
  StoreClock,
  type ExecutionLease,
  type InterruptMode,
  type NewStatusTransition,
  type PauseMarks,
  type PauseRequest,
  type StopMark,
  type TreeMarks,
} from "@agboss/core";
import {
  CLUSTER_LEASE_EXPIRY,
  ClusterLeaseSyncOutcome,
  MirroredLeaseState,
  type ClusterLeaseMirror,
  type ClusterLeaseSync,
  type ExecutionTree,
  type MirroredLease,
} from "@agboss/core/stores";
import type { Collection } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import { settled } from "../connection/outcome.js";
import { markCancel } from "./cancel-fence.js";
import { DUPLICATE_KEY, hasCode, treeIdOf } from "./keys.js";
import type { LeaseDocument } from "./lease-documents.js";
import { liftPause, markPause, markStop, marked, marksOf, pauseMarksOf } from "./lease-marks.js";
import { literal } from "./store-time.js";

const Mirror = z.object({
  holderInstanceId: z.string(),
  token: z.number().int(),
  released: z.boolean(),
  finished: z.boolean(),
});

/**
 * The part of the lease store that keeps the tree's marks and mirrors a cluster's lease (agbossjs/agboss#1321e,
 * #1341): the base of `MongoExecutionLeaseRepository`. Each mark is ONE update of the tree's lease
 * document — monotone in the server (`lease-marks.ts`) — and, with its history document, one
 * transaction; the document is the authority (D6).
 */
export abstract class MongoLeaseMarks
  extends ExecutionLeaseRepository
  implements ClusterLeaseMirror
{
  constructor(
    protected readonly connection: MongoConnection,
    protected readonly clock: StoreClock,
    protected readonly applicationContext: ApplicationContext,
  ) {
    super();
  }

  protected get leases(): Collection<LeaseDocument> {
    return this.connection.db.collection<LeaseDocument>(Collections.ExecutionLeases);
  }

  /**
   * Marks the tree's cancel (#909, #1117): once, never cleared; with its history document, in one
   * transaction.
   */
  requestCancel(tree: ExecutionTree, transition?: NewStatusTransition): Promise<void> {
    const write = { clock: this.clock, transition };
    return marked(this.connection, write, "requestCancel", (scope) =>
      markCancel(scope, tree, write),
    );
  }

  /**
   * Whether the tree's cancel mark is set (#1152): `cancelRequestedAt` on the lease document of
   * `(tenantId, rootExecutionId)` — tenant-scoped by the document's key, a seed document counts —,
   * one majority read, changing nothing.
   */
  async isCancelRequested(tree: ExecutionTree): Promise<boolean> {
    return (await marksOf(this.connection.db, tree)).isCancelRequested;
  }

  requestStop(
    tree: ExecutionTree,
    mode: InterruptMode,
    transition?: NewStatusTransition,
  ): Promise<void> {
    const write = { clock: this.clock, transition };
    return marked(this.connection, write, "requestStop", (scope) =>
      markStop(scope, tree, mode, write),
    );
  }

  async stopOf(tree: ExecutionTree): Promise<StopMark | undefined> {
    return (await marksOf(this.connection.db, tree)).stop;
  }

  /** Both marks and the pause of the tree's document in one read. */
  override markedOf(tree: ExecutionTree): Promise<TreeMarks> {
    return marksOf(this.connection.db, tree);
  }

  requestPause(
    tree: ExecutionTree,
    request: PauseRequest,
    transition?: NewStatusTransition,
  ): Promise<void> {
    const write = { clock: this.clock, transition };
    return marked(this.connection, write, "requestPause", (scope) =>
      markPause(scope, tree, request, write),
    );
  }

  unpause(tree: ExecutionTree, transition?: NewStatusTransition): Promise<void> {
    const write = { clock: this.clock, transition };
    return marked(this.connection, write, "unpause", (scope) => liftPause(scope, tree, write));
  }

  pauseOf(tree: ExecutionTree): Promise<PauseMarks> {
    return pauseMarksOf(this.connection.db, tree);
  }

  /**
   * Writes the cluster's lease into the tree's document in ONE atomic upsert (#1321e, D6): only
   * above the document's token, or at it for the same holder not yet released; never over a retired
   * (`finished`) document. The marks and the fence are not touched. A document the filter does not
   * match makes the upsert's insert a duplicate `_id`: `Retired` when it is finished, else `Behind`.
   */
  syncClusterLease(lease: ExecutionLease): Promise<ClusterLeaseSync> {
    return settled("syncClusterLease", () => this.#sync(lease));
  }

  async #sync(lease: ExecutionLease): Promise<ClusterLeaseSync> {
    const id = treeIdOf(lease.tenantId, lease.rootExecutionId);
    try {
      await this.leases.updateOne(
        {
          _id: id,
          finished: false,
          $or: [
            { token: { $lt: lease.token } },
            { token: lease.token, holderInstanceId: lease.holderInstanceId, released: false },
          ],
        },
        [
          {
            $set: {
              tenantId: literal(lease.tenantId),
              rootExecutionId: literal(lease.rootExecutionId),
              holderInstanceId: literal(lease.holderInstanceId),
              token: lease.token,
              expiresAt: CLUSTER_LEASE_EXPIRY,
              released: false,
              yielded: false,
              superseded: false,
              finished: false,
            },
          },
        ],
        { upsert: true },
      );
      return { outcome: ClusterLeaseSyncOutcome.Synced };
    } catch (error) {
      if (!hasCode(error, DUPLICATE_KEY)) throw error;
    }
    const stored = await this.#mirrorDocument(lease);
    if (stored?.finished === true) return { outcome: ClusterLeaseSyncOutcome.Retired };
    return { outcome: ClusterLeaseSyncOutcome.Behind, rowToken: stored?.token ?? lease.token };
  }

  async endClusterLease(
    lease: ExecutionLease,
    end: { readonly isRetired: boolean },
  ): Promise<void> {
    await (end.isRetired ? this.retire(lease) : this.release(lease));
  }

  async mirroredLeaseOf(tree: ExecutionTree): Promise<MirroredLease | undefined> {
    const stored = await this.#mirrorDocument(tree);
    if (stored === undefined) return undefined;
    let state = MirroredLeaseState.Held;
    if (stored.finished) state = MirroredLeaseState.Retired;
    else if (stored.released) state = MirroredLeaseState.Released;
    return { token: stored.token, holderInstanceId: stored.holderInstanceId, state };
  }

  async #mirrorDocument(tree: Pick<ExecutionTree, "tenantId" | "rootExecutionId">) {
    const found = await this.leases.findOne(
      { _id: treeIdOf(tree.tenantId, tree.rootExecutionId) },
      { projection: { holderInstanceId: 1, token: 1, released: 1, finished: 1 } },
    );
    return found === null ? undefined : Mirror.parse(found);
  }
}
