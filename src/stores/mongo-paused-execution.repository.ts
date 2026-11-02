import {
  Clock,
  Injectable,
  PausedExecutionRepository,
  PauseResolution,
  PauseStatus,
  type PauseAnswer,
  type PauseCancellation,
  type PausedExecution,
  type PauseRecord,
} from "@agboss/core";
import type { Collection } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import { pausedRunJsonOf, pausedRunOfJson } from "./framework-json.js";
import { idOf } from "./keys.js";
import {
  closePause,
  findOrCreatePause,
  pauseIdOf,
  pauseOfDocument,
  type PauseDocument,
} from "./paused/pause-documents.js";

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
 * `PausedExecutionRepository` on MongoDB (#265, #267 S35, agbossjs/agboss#527): one document per
 * thread of a tenant — the paused run and the versions it paused under — and one per pause. Every
 * transition of a pending pause is one compare-and-set (`findOneAndUpdate` filtered on `status:
 * "pending"`), so of two resumes on two instances exactly one records its decision; the other gets
 * nothing back — `NotPausedError` from the core. With `MongoCheckpointSaver` a pause made on one
 * instance is resumed on any.
 */
@Injectable({ deps: [MongoConnection, Clock] })
export class MongoPausedExecutionRepository extends PausedExecutionRepository {
  constructor(
    private readonly connection: MongoConnection,
    private readonly clock: Clock,
  ) {
    super();
  }

  get #paused(): Collection<PausedDocument> {
    return this.connection.db.collection<PausedDocument>(Collections.PausedExecutions);
  }

  get #pauses(): Collection<PauseDocument> {
    return this.connection.db.collection<PauseDocument>(Collections.Pauses);
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

  findOrCreateByStepKey(pause: PauseRecord): Promise<PauseRecord> {
    return findOrCreatePause(this.connection.db, pause);
  }

  async findByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
  ): Promise<PauseRecord | undefined> {
    const found = await this.#pauses.findOne({ _id: pauseIdOf(tenantId, pauseId) });
    return found === null ? undefined : pauseOfDocument(found);
  }

  async findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly PauseRecord[]> {
    const found = await this.#pauses.find({ tenantId, rootExecutionId }).sort({ seq: 1 }).toArray();
    return found.map(pauseOfDocument);
  }

  async markSentByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<boolean> {
    const sent = await this.#pauses.updateOne(
      { _id: pauseIdOf(tenantId, pauseId), status: PauseStatus.Pending },
      { $set: { isSent: true } },
    );
    return sent.matchedCount === 1;
  }

  resolveByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<PauseRecord | undefined> {
    const resolution = PauseResolution.Replied;
    return closePause(this.#pauses, tenantId, pauseId, {
      ...{ status: PauseStatus.Resolved, answer, resolution, at },
    });
  }

  async decideByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<boolean> {
    const closed = await closePause(this.#pauses, tenantId, pauseId, {
      ...{ status: PauseStatus.Taken, answer, resolution: PauseResolution.Decided, at },
    });
    return closed !== undefined;
  }

  async cancelByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseCancellation,
    at: Date,
  ): Promise<boolean> {
    const closed = await closePause(this.#pauses, tenantId, pauseId, {
      ...{ status: PauseStatus.Cancelled, resolution, at },
    });
    return closed !== undefined;
  }

  async markTakenByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<void> {
    await this.#pauses.updateOne(
      { _id: pauseIdOf(tenantId, pauseId), status: PauseStatus.Resolved },
      { $set: { status: PauseStatus.Taken } },
    );
  }

  async deleteResolvedBefore(cutoff: Date): Promise<void> {
    await this.#pauses.deleteMany({
      status: { $in: [PauseStatus.Taken, PauseStatus.Cancelled] },
      resolvedAt: { $lt: cutoff },
    });
  }
}
