import {
  Clock,
  PausedExecutionRepository,
  type PausedExecution,
  type PauseRecord,
} from "@agboss/core";
import type { Collection, Filter } from "mongodb";
import { z } from "zod";
import { Collections } from "../../connection/collections.js";
import type { MongoConnection } from "../../connection/mongodb-connection.js";
import type { MongoTransaction } from "../../connection/transaction.js";
import { pausedRunJsonOf, pausedRunOfJson } from "../framework-json.js";
import { idOf } from "../keys.js";
import type { PauseChange, PlannedNotice } from "./pause-changes.js";
import { fieldsOf, pauseIdOf, pauseOfDocument, type PauseDocument } from "./pause-documents.js";
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

const Paused = z.object({ run: z.string(), workflowVersion: z.string(), configHash: z.string() });

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

  /** The pause `plan` changes where `guard` holds: the record as it is now, `undefined` when nothing changed. */
  protected change(
    tenantId: string,
    pauseId: string,
    guard: Filter<PauseDocument>,
    plan: (before: PauseRecord) => PauseChange | undefined,
  ): Promise<PauseRecord | undefined> {
    return this.connection.inTransaction(async (transaction) => {
      const { db, session } = transaction;
      const pauses = db.collection<PauseDocument>(Collections.Pauses);
      const _id = pauseIdOf(tenantId, pauseId);
      const found = await pauses.findOne({ _id }, { session });
      const change = found === null ? undefined : plan(pauseOfDocument(found));
      if (change === undefined) return undefined;
      const recorded = await pauses.updateOne(
        { _id, ...guard },
        { $set: fieldsOf(change.pause) },
        { session },
      );
      if (recorded.matchedCount === 0) return undefined;
      await this.appendNotices(transaction, change.pause, change.notices);
      return change.pause;
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
      run: pausedRunOfJson(stored.run),
      workflowVersion: stored.workflowVersion,
      configHash: stored.configHash,
    };
  }

  async save(paused: PausedExecution): Promise<void> {
    const { run } = paused;
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
