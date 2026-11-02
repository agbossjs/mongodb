import {
  ApplicationContext,
  Clock,
  DuplicateThreadIdError,
  ExecutionRecordRepository,
  ExecutionRecordStatus,
  IdGenerator,
  idGeneratorNameOf,
  Injectable,
} from "@agboss/core";
import { MongoConnection } from "../connection/mongodb-connection.js";
import { pauseAnswerOfJson } from "./framework-json.js";
import * as memory from "./records/record-memory.js";
import * as reads from "./records/record-reads.js";
import type * as rows from "./records/record-documents.js";
import * as scores from "./records/record-scores.js";
import * as writes from "./records/record-writes.js";

/** How many minted ids a new thread tries before it gives up (agbossjs/agboss#550). */
const MINTED_THREAD_TRIES = 100;

/**
 * `ExecutionRecordRepository` on MongoDB (#265 S30, agbossjs/agboss#527): threads with their owners
 * (`_id` the tenant and thread id: a thread id is created once), one record per execution in the
 * order appended (`seq`, the records' sequence — never a client's clock), scores, memory summaries,
 * config snapshots and the permanent log of resolved pauses — so recovery on any instance finds the
 * roots a dead one left `running`, and `--thread` reads earlier turns. Every write is one command;
 * the status write that must not land late is a compare-and-set (`completeIfStatus`: an update
 * filtered on the expected status). Times are the `Clock`'s, a new thread's id the
 * `IdGenerator`'s (#313). Listed in `@Application({ providers })` with `mongodbUrl`; subclassed
 * through public tokens only:
 * `deps: [MongoConnection, Clock, ApplicationContext, IdGenerator]`.
 */
@Injectable({ deps: [MongoConnection, Clock, ApplicationContext, IdGenerator] })
export class MongoExecutionRecordRepository extends ExecutionRecordRepository {
  constructor(
    private readonly connection: MongoConnection,
    private readonly clock: Clock,
    applicationContext: ApplicationContext,
    private readonly idGenerator: IdGenerator,
  ) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  /**
   * A new thread (agbossjs/agboss#550): a caller's own id is kept as it is (the first one keeps it);
   * a minted one the tenant has already — an `IdGenerator` that repeats its ids — is never handed
   * out: the next one is minted, at most `MINTED_THREAD_TRIES` times, then `DuplicateThreadIdError`
   * (agbossjs/agboss#613).
   */
  async createThread(thread: rows.NewThreadRecord): Promise<string> {
    if (thread.threadId !== undefined) {
      await writes.createThread(this.connection.db, thread, thread.threadId, this.clock.now());
      return thread.threadId;
    }
    for (let tries = 0; tries < MINTED_THREAD_TRIES; tries += 1) {
      const id = this.idGenerator.newThreadId();
      if (await writes.createThread(this.connection.db, thread, id, this.clock.now())) return id;
    }
    // agbossjs/agboss#613: the core's typed refusal, naming the project's generator class
    throw new DuplicateThreadIdError(idGeneratorNameOf(this.idGenerator), MINTED_THREAD_TRIES);
  }
  async hasThread(workflow: string, tenantId: string, threadId: string): Promise<boolean> {
    return (await this.threadOwner(workflow, tenantId, threadId)) !== undefined;
  }
  threadOwner(
    workflow: string,
    tenantId: string,
    threadId: string,
  ): Promise<{ readonly owner: string | undefined } | undefined> {
    return writes.threadOwnerOf(this.connection.db, workflow, tenantId, threadId);
  }
  append(record: rows.NewRecord): Promise<rows.StoredRecord> {
    return writes.appendRecord(this.connection.db, record, this.clock.now());
  }
  async complete(id: string, outcome: rows.RecordOutcome): Promise<void> {
    await writes.completeRecord(this.connection.db, id, outcome);
  }
  completeIfStatus(
    id: string,
    expected: ExecutionRecordStatus,
    outcome: rows.RecordOutcome,
  ): Promise<boolean> {
    return writes.completeRecord(this.connection.db, id, outcome, expected);
  }
  lastTerns(tenantId: string, threadId: string, limit: number): Promise<rows.StoredRecord[]> {
    return reads.lastRecordsOf(this.connection.db, tenantId, threadId, limit);
  }
  byIds(ids: readonly string[]): Promise<rows.StoredRecord[]> {
    return reads.recordsByIds(this.connection.db, ids);
  }
  findByStatus(
    status: ExecutionRecordStatus,
    limit: number,
    after?: string,
  ): Promise<rows.StoredRecord[]> {
    return reads.recordsByStatus(this.connection.db, status, limit, after);
  }
  byVersion(workflow: string, promptVersion: string, limit: number): Promise<rows.StoredRecord[]> {
    return reads.recordsByVersion(this.connection.db, workflow, promptVersion, limit);
  }
  unscored(
    workflow: string,
    promptVersion: string | undefined,
    limit: number,
  ): Promise<rows.StoredRecord[]> {
    return reads.unscoredRecords(this.connection.db, workflow, promptVersion, limit);
  }
  saveScore(recordId: string, judge: string, score: number): Promise<void> {
    return scores.saveScore(this.connection.db, recordId, judge, score, this.clock.now());
  }
  meanScore(recordIds: readonly string[]): Promise<number | null> {
    return scores.meanScoreOf(this.connection.db, recordIds);
  }
  summary(workflow: string): Promise<rows.StoredVersionScore[]> {
    return scores.versionScoresOf(this.connection.db, workflow);
  }
  rememberConfig(
    workflow: string,
    version: string,
    hash: string,
    snapshot: string,
  ): Promise<{ readonly drift: boolean }> {
    const now = this.clock.now();
    return scores.rememberConfig(this.connection.db, workflow, version, hash, snapshot, now);
  }
  configSnapshots(workflow: string, version: string): Promise<rows.StoredConfigSnapshot[]> {
    return scores.configSnapshotsOf(this.connection.db, workflow, version);
  }
  recentOriginals(workflow: string, limit: number): Promise<rows.StoredRecord[]> {
    return reads.recentOriginalRecords(this.connection.db, workflow, limit);
  }
  uncovered(tenantId: string, threadId: string, compaction: string): Promise<rows.StoredRecord[]> {
    return memory.uncoveredRecords(this.connection.db, tenantId, threadId, compaction);
  }
  before(
    tenantId: string,
    threadId: string,
    ternId: string,
    limit: number,
  ): Promise<rows.StoredRecord[]> {
    return memory.recordsBefore(this.connection.db, tenantId, threadId, ternId, limit);
  }
  turnNumber(tenantId: string, threadId: string, ternId: string): Promise<number> {
    return memory.turnNumberOf(this.connection.db, tenantId, threadId, ternId);
  }
  addSummary(summary: rows.NewSummaryRecord): Promise<rows.StoredSummary> {
    return memory.addSummary(this.connection.db, summary, this.clock.now());
  }
  latestSummaries(
    tenantId: string,
    threadId: string,
    compaction: string,
    limit: number,
  ): Promise<rows.StoredSummary[]> {
    return memory.latestSummariesOf(this.connection.db, tenantId, threadId, compaction, limit);
  }
  summaryCount(tenantId: string, threadId: string, compaction: string): Promise<number> {
    return memory.summaryCountOf(this.connection.db, tenantId, threadId, compaction);
  }
  savePauseAnswer(
    tenantId: string,
    rootExecutionId: string,
    answer: rows.PauseAnswer,
  ): Promise<void> {
    return writes.savePauseAnswer(this.connection.db, tenantId, rootExecutionId, answer);
  }
  async findPauseAnswersByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<rows.PauseAnswer[]> {
    const texts = await writes.pauseAnswerTextsOf(this.connection.db, tenantId, rootExecutionId);
    return texts.map(pauseAnswerOfJson);
  }
}
