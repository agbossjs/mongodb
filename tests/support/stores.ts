import { ExecutionRecordStatus, IdGenerator } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { afterEach } from "vitest";
import { MongoConnection, MongoExecutionRecordRepository } from "../../src/index.js";
import { TestApplicationContext } from "./application-context.js";
import type { NewRecord, RecordOutcome } from "../../src/stores/records/record-documents.js";

/** The connections a test opened, ended after it. */
const opened: MongoConnection[] = [];

afterEach(async () => {
  for (const connection of opened.splice(0)) await connection.onDestroy();
});

/** A connection of this test to `url` (ended after the test). */
export function connectionTo(url: string): MongoConnection {
  const connection = new MongoConnection({ url });
  opened.push(connection);
  return connection;
}

/** Thread ids `thread-1`, `thread-2`, … */
export class CountingIdGenerator extends IdGenerator {
  #threads = 0;
  #executions = 0;

  newThreadId(): string {
    this.#threads += 1;
    return `thread-${String(this.#threads)}`;
  }

  newExecutionId(): string {
    this.#executions += 1;
    return `execution-${String(this.#executions)}`;
  }
}

/** The thread ids of a test file's record stores: one counter, so no two tests share a thread. */
const fileIds = new CountingIdGenerator();

/** A record store on `url`, on `clock`. */
export function recordsOn(
  url: string,
  clock: VirtualClock = new VirtualClock(),
  ids: IdGenerator = fileIds,
): MongoExecutionRecordRepository {
  return new MongoExecutionRecordRepository(
    connectionTo(url),
    clock,
    new TestApplicationContext({}),
    ids,
  );
}

/** An outcome with `status`. */
export const outcomeOf = (
  status: ExecutionRecordStatus,
  fields: Partial<RecordOutcome> = {},
): RecordOutcome => ({
  replyWith: status === ExecutionRecordStatus.Answered ? "Done." : "",
  status,
  stopReason: "",
  route: ["start", "clerk"],
  steps: [{ agent: "clerk", content: "looked it up" }],
  costUsd: 0.01,
  ...fields,
});

/** A new record of `threadId`. */
export const recordOf = (
  threadId: string,
  status: ExecutionRecordStatus,
  fields: Partial<NewRecord> = {},
): NewRecord => ({
  ...outcomeOf(status),
  runId: "run-1",
  threadId,
  tenantId: "default",
  bundle: "desk-workflow",
  task: "where is order 7?",
  promptVersion: "p1",
  modelVersion: "m1",
  replayOf: null,
  configVersion: "1.0.0",
  configHash: "hash",
  ...fields,
});
