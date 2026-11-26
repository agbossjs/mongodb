import {
  ApplicationContext,
  Clock,
  ExecutionRecordRepository,
  ExecutionRecordStatus,
  IdGenerator,
  Injectable,
  type ConfigSnapshot,
  type NewSummary,
  type NewThread,
  type NewTurn,
  type PauseAnswerRecord,
  type Summary,
  type ThreadStatusTransition,
  type Turn,
  type TurnOutcome,
  type VersionScore,
  ExecutionError,
} from "@agboss/core";
import {
  idGeneratorNameOf,
  type EndedTree,
  type ExecutionRecordStatusQuery,
  type Page,
  type StatusContext,
} from "@agboss/core/stores";
import { MongoConnection } from "../connection/mongodb-connection.js";
import { pauseAnswerOfJson } from "./framework-json.js";
import { completeUnlessInterrupted } from "./records/record-interrupt.js";
import * as memories from "./records/record-memory.js";
import * as reads from "./records/record-reads.js";
import * as scores from "./records/record-scores.js";
import { deleteIdleThreads } from "./records/record-idle.js";
import * as threads from "./records/record-threads.js";
import * as writes from "./records/record-writes.js";
import { forgottenStatus, historyOf } from "./status-log.js";

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
   * out: the next one is minted, at most `MINTED_THREAD_TRIES` times, then `ExecutionError.ThreadIdsExhausted`
   * (agbossjs/agboss#613).
   */
  async createThread(thread: NewThread): Promise<string> {
    if (thread.threadId !== undefined) {
      await threads.createOwnThread(this.connection.db, thread, thread.threadId, this.clock.now());
      return thread.threadId;
    }
    for (let tries = 0; tries < MINTED_THREAD_TRIES; tries += 1) {
      const id = this.idGenerator.newThreadId();
      if (await threads.createThread(this.connection.db, thread, id, this.clock.now())) return id;
    }
    // agbossjs/agboss#613: the core's typed refusal, naming the project's generator class
    throw new ExecutionError.ThreadIdsExhausted({
      generator: idGeneratorNameOf(this.idGenerator),
      tries: MINTED_THREAD_TRIES,
    });
  }
  async hasThread(workflow: string, tenantId: string, threadId: string): Promise<boolean> {
    return (await this.threadOwner(workflow, tenantId, threadId)) !== undefined;
  }
  threadOwner(
    workflow: string,
    tenantId: string,
    threadId: string,
  ): Promise<{ readonly owner: string | undefined; readonly isSwept?: true } | undefined> {
    return threads.threadOwnerOf(this.connection.db, workflow, tenantId, threadId);
  }
  append(record: NewTurn, context?: StatusContext): Promise<Turn> {
    return writes.appendRecord(this.connection, record, { now: this.clock.now(), context });
  }
  async complete(id: string, outcome: TurnOutcome, context?: StatusContext): Promise<void> {
    await writes.completeRecord(this.connection, id, outcome, { now: this.clock.now(), context });
  }
  completeIfStatus(
    id: string,
    expected: ExecutionRecordStatus,
    outcome: TurnOutcome,
    context?: StatusContext,
  ): Promise<boolean> {
    return writes.completeRecord(this.connection, id, outcome, {
      now: this.clock.now(),
      expected,
      context,
    });
  }
  completeUnlessInterrupted(
    id: string,
    outcome: TurnOutcome,
    context?: StatusContext,
  ): Promise<boolean> {
    const write = { now: this.clock.now(), context };
    return completeUnlessInterrupted(this.connection, id, outcome, write);
  }
  statusHistory(tenantId: string, threadId: string): Promise<readonly ThreadStatusTransition[]> {
    return historyOf(this.connection.db, { tenantId, threadId });
  }
  forgetStatusHistory(tenantId: string, threadId: string): Promise<void> {
    return forgottenStatus(this.connection.db, { tenantId, threadId });
  }
  deleteIdleThreads(cutoffs: ReadonlyMap<string, Date>, isEnded: EndedTree): Promise<number> {
    return deleteIdleThreads(this.connection, cutoffs, isEnded);
  }
  lastTurns(tenantId: string, threadId: string, limit: number): Promise<Turn[]> {
    return reads.lastRecordsOf(this.connection.db, tenantId, threadId, limit);
  }
  findByTenantIdAndRunId(tenantId: string, runId: string): Promise<Turn | undefined> {
    return reads.recordByRunIdOf(this.connection.db, tenantId, runId);
  }
  byIds(ids: readonly string[]): Promise<Turn[]> {
    return reads.recordsByIds(this.connection.db, ids);
  }
  findByStatus(query: ExecutionRecordStatusQuery): Promise<Page<Turn>> {
    return reads.statusPageOf(this.connection.db, query);
  }
  byVersion(workflow: string, promptVersion: string, limit: number): Promise<Turn[]> {
    return reads.recordsByVersion(this.connection.db, workflow, promptVersion, limit);
  }
  unscored(workflow: string, promptVersion: string | undefined, limit: number): Promise<Turn[]> {
    return reads.unscoredRecords(this.connection.db, workflow, promptVersion, limit);
  }
  saveScore(recordId: string, judge: string, score: number): Promise<void> {
    return scores.saveScore(this.connection.db, recordId, judge, score, this.clock.now());
  }
  meanScore(recordIds: readonly string[]): Promise<number | null> {
    return scores.meanScoreOf(this.connection.db, recordIds);
  }
  summary(workflow: string): Promise<VersionScore[]> {
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
  configSnapshots(workflow: string, version: string): Promise<ConfigSnapshot[]> {
    return scores.configSnapshotsOf(this.connection.db, workflow, version);
  }
  recentOriginals(workflow: string, limit: number): Promise<Turn[]> {
    return reads.recentOriginalRecords(this.connection.db, workflow, limit);
  }
  uncovered(tenantId: string, threadId: string, memory: string): Promise<Turn[]> {
    return memories.uncoveredRecords(this.connection.db, tenantId, threadId, memory);
  }
  before(tenantId: string, threadId: string, turnId: string, limit: number): Promise<Turn[]> {
    return memories.recordsBefore(this.connection.db, tenantId, threadId, turnId, limit);
  }
  turnNumber(tenantId: string, threadId: string, turnId: string): Promise<number> {
    return memories.turnNumberOf(this.connection.db, tenantId, threadId, turnId);
  }
  addSummary(summary: NewSummary): Promise<Summary> {
    return memories.addSummary(this.connection.db, summary, this.clock.now());
  }
  latestSummaries(
    tenantId: string,
    threadId: string,
    memory: string,
    limit: number,
  ): Promise<Summary[]> {
    return memories.latestSummariesOf(this.connection.db, tenantId, threadId, memory, limit);
  }
  summaryCount(tenantId: string, threadId: string, memory: string): Promise<number> {
    return memories.summaryCountOf(this.connection.db, tenantId, threadId, memory);
  }
  savePauseAnswer(
    tenantId: string,
    rootExecutionId: string,
    answer: PauseAnswerRecord,
  ): Promise<void> {
    return writes.savePauseAnswer(this.connection.db, tenantId, rootExecutionId, answer);
  }
  markPauseAnswerNotTaken(
    tenantId: string,
    rootExecutionId: string,
    answer: PauseAnswerRecord,
  ): Promise<void> {
    return writes.markPauseAnswerNotTaken(this.connection.db, tenantId, rootExecutionId, answer);
  }

  async findPauseAnswersByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<PauseAnswerRecord[]> {
    const texts = await writes.pauseAnswerTextsOf(this.connection.db, tenantId, rootExecutionId);
    return texts.map((text) => pauseAnswerOfJson(text, { executionId: rootExecutionId }));
  }
}
