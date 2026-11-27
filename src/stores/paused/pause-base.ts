import {
  Clock,
  PausedExecutionRepository,
  type PausedExecution,
  type PauseRecord,
} from "@agboss/core";
import { assertValidInstant, type PauseTransition, type PlannedNotice } from "@agboss/core/stores";
import type { Collection, Filter } from "mongodb";
import { z } from "zod";
import { Collections } from "../../connection/collections.js";
import type { MongoConnection } from "../../connection/mongodb-connection.js";
import type { MongoTransaction } from "../../connection/transaction.js";
import { pausedRunJsonOf, pausedRunOfJson } from "../framework-json.js";
import { idOf } from "../keys.js";
import {
  pauseIdOf,
  pauseOfDocument,
  returnedPause,
  writtenFieldsOf,
  type PauseDocument,
} from "./pause-documents.js";
import { PAUSE_GUARDS, type PauseGuards } from "./pause-guards.js";
import { appendNotice } from "./pause-mailboxes.js";

/** One thread's paused run: the run as JSON text (its non-finite numbers tagged) and its versions. */
interface PausedDocument {
  _id: string;
  runId: string;
  run: string;
  workflowVersion: string;
  configHash: string;
  pausedAt: Date;
}

const Paused = z.object({
  runId: z.string(),
  run: z.string(),
  workflowVersion: z.string(),
  configHash: z.string(),
});

/**
 * The first layer of `MongoPausedExecutionRepository`: the paused runs by thread, and the one way
 * a pause changes (#938) — in one transaction, read the pause, plan the change, record it with a
 * compare-and-set whose filter is the transition's guard (`pause-guards.ts`), then append its
 * notices in the same transaction, in the order planned. `work` does nothing outside the session:
 * the driver may run it again.
 */
export abstract class MongoPauseBase extends PausedExecutionRepository {
  constructor(
    protected readonly connection: MongoConnection,
    protected readonly clock: Clock,
  ) {
    super();
  }

  /** The compare-and-set conditions; a store of a test replaces them to break one. */
  protected get guards(): PauseGuards {
    return PAUSE_GUARDS;
  }

  /** Appends the notices of a change inside its transaction. */
  protected async appendNotices(
    transaction: MongoTransaction,
    pause: PauseRecord,
    notices: readonly PlannedNotice[],
  ): Promise<void> {
    for (const planned of notices)
      await appendNotice(transaction.db, transaction.session, pause, planned);
  }

  protected get pauses(): Collection<PauseDocument> {
    return this.connection.db.collection<PauseDocument>(Collections.Pauses);
  }

  get #paused(): Collection<PausedDocument> {
    return this.connection.db.collection<PausedDocument>(Collections.PausedExecutions);
  }

  /**
   * The pause `plan` changes where `guard` holds: the record as it is now, `undefined` when nothing
   * changed. An Invalid Date for `at` is refused first (a `StoreError.UnreadableRecord`, nothing
   * written), whether or not the pause exists.
   */
  protected change(
    tenantId: string,
    pauseId: string,
    at: Date,
    guard: Filter<PauseDocument>,
    plan: (before: PauseRecord) => PauseTransition | undefined,
  ): Promise<PauseRecord | undefined> {
    return this.connection.inTransaction(async (transaction) => {
      assertValidInstant(at, "at");
      const { db, session } = transaction;
      const pauses = db.collection<PauseDocument>(Collections.Pauses);
      const _id = pauseIdOf(tenantId, pauseId);
      const found = await pauses.findOne({ _id }, { session });
      const before = found === null ? undefined : pauseOfDocument(found);
      const change = before === undefined ? undefined : plan(before);
      if (before === undefined || change === undefined) return undefined;
      const recorded = await pauses.updateOne(
        { _id, ...guard },
        writtenFieldsOf(before, change.pause),
        { session },
      );
      if (recorded.matchedCount === 0) return undefined;
      await this.appendNotices(transaction, change.pause, change.notices);
      // a copy: the caller's own `at` and deadline instances are never inside what comes back
      return returnedPause(change.pause);
    });
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async findByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
  ): Promise<PausedExecution | undefined> {
    const found = await this.#paused.findOne({ _id: idOf(tenantId, threadId) });
    if (found === null) return undefined;
    const stored = Paused.parse(found);
    return {
      run: pausedRunOfJson(stored.run, { threadId, runId: stored.runId }),
      workflowVersion: stored.workflowVersion,
      configHash: stored.configHash,
    };
  }

  async save(paused: PausedExecution): Promise<void> {
    const { run } = paused;
    // an Invalid Date would be written as `null` and make the run unreadable on every later read
    for (const [index, pending] of run.pending.entries())
      assertValidInstant(pending.expiresAt, `pending[${String(index)}].expiresAt`, "paused run");
    await this.#paused.replaceOne(
      { _id: idOf(run.tenantId, run.threadId) },
      {
        runId: run.runId,
        run: pausedRunJsonOf(run),
        workflowVersion: paused.workflowVersion,
        configHash: paused.configHash,
        pausedAt: this.clock.now(),
      },
      { upsert: true },
    );
  }

  async deleteByTenantIdAndThreadId(tenantId: string, threadId: string): Promise<void> {
    await this.#paused.deleteOne({ _id: idOf(tenantId, threadId) });
  }

  /** One statement: another run's paused run, saved since, is never removed (I13). */
  async deleteByTenantIdAndThreadIdAndRunId(
    tenantId: string,
    threadId: string,
    runId: string,
  ): Promise<void> {
    await this.#paused.deleteOne({ _id: idOf(tenantId, threadId), runId });
  }
}
