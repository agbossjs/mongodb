/**
 * agbossjs/agboss#1213: the framework's JSON records a store keeps — a pause read back by the core,
 * a paused run whose non-finite numbers JSON cannot hold are tagged and restored.
 */
import {
  PauseAnswerer,
  PauseKind,
  PauseStatus,
  type PausedExecution,
  type PauseRecord,
} from "@agboss/core";
import { StoredNamesUnreadableError } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import {
  pauseAnswerOfJson,
  pausedRunJsonOf,
  pausedRunOfJson,
  pauseRecordOf,
} from "../../src/stores/framework-json.js";
import { oldAnswerLogEntry, oldPausedRun } from "../stores/pause-names-0.1.0.fixtures.js";

// read in a test, not at the import: a mutant of the reading that fails here must fail a test, which kills it,
// not the import of the file, which Stryker leaves out of the score (agbossjs/mongodb#103)
const base = (): PausedExecution["run"] => pausedRunOfJson(JSON.stringify(oldPausedRun));
const run = (extra: Partial<PausedExecution["run"]>): PausedExecution["run"] => ({
  ...base(),
  ...extra,
});

const pause: PauseRecord = {
  pauseId: "pause-1",
  tenantId: "default",
  threadId: "thread-1",
  rootExecutionId: "run-1",
  executionId: "run-1",
  workflow: "order-workflow",
  stepKey: "step-1",
  nodeId: "clerk-agent",
  visitNumber: 1,
  itemIndex: undefined,
  copyNumber: 1,
  kind: PauseKind.Approval,
  step: "clerk-agent",
  channel: "refund-approval-channel",
  answerer: PauseAnswerer.Channel,
  ask: { callId: "call-1", tool: "charge", arguments: { text: "10 USD" }, summary: "charge" },
  status: PauseStatus.Pending,
  isSent: false,
  askedAt: "2026-01-05T09:00:00.000Z",
};

describe("pauseRecordOf", () => {
  it("reads the record a document keeps, whole", () => {
    expect(pauseRecordOf(JSON.parse(JSON.stringify(pause)))).toEqual(pause);
  });
});

describe("a paused run's non-finite numbers", () => {
  it("Infinity (a run without a cost limit) is written tagged and read back as itself", () => {
    const text = pausedRunJsonOf(run({ budgetUsd: Number.POSITIVE_INFINITY }));

    expect(text).toContain('"budgetUsd":{"$number":"Infinity"}');
    expect(pausedRunOfJson(text).budgetUsd).toBe(Number.POSITIVE_INFINITY);
  });

  it("-Infinity and NaN are written tagged and read back as themselves", () => {
    const output = [Number.NEGATIVE_INFINITY, Number.NaN, 1.5, "NaN"];
    const text = pausedRunJsonOf(run({ output }));

    expect(text).toContain('"output":[{"$number":"-Infinity"},{"$number":"NaN"},1.5,"NaN"]');
    expect(pausedRunOfJson(text).output).toEqual(output);
  });

  it("a finite number is written as it is", () => {
    const text = pausedRunJsonOf(run({ budgetUsd: 5 }));

    expect(text).toContain('"budgetUsd":5');
    expect(pausedRunOfJson(text).budgetUsd).toBe(5);
  });

  it("an object that is not a tag stays an object: a $number of no known name, or no $number", () => {
    const output = { $number: "Bogus", other: { x: 1 } };
    const text = pausedRunJsonOf(run({ output }));

    expect(pausedRunOfJson(text).output).toEqual(output);
    expect(pausedRunOfJson(pausedRunJsonOf(run({ output: { a: 1 } }))).output).toEqual({ a: 1 });
  });
});

describe("the records a store keeps as JSON are read whole by the core", () => {
  it("a pause's log entry is read from its JSON", () => {
    const answer = pauseAnswerOfJson(JSON.stringify(oldAnswerLogEntry), { executionId: "run-1" });

    expect(answer).toMatchObject({ executionId: "run-1", answeredBy: "manager-17" });
  });

  it("a log entry that is not JSON is unreadable: it names what it is and the ids, never the text", () => {
    expect(() => pauseAnswerOfJson("{not json", { executionId: "run-9" })).toThrow(
      StoredNamesUnreadableError,
    );
    expect(() => pauseAnswerOfJson("{not json", { executionId: "run-9" })).toThrow(/pause answer/);
    expect(() => pauseAnswerOfJson("{not json", { executionId: "run-9" })).toThrow(/run-9/);
  });

  it("a paused run that is not JSON is unreadable: it names what it is and the ids", () => {
    expect(() => pausedRunOfJson("{not json", { threadId: "thread-9", runId: "run-9" })).toThrow(
      StoredNamesUnreadableError,
    );
    expect(() => pausedRunOfJson("{not json", { threadId: "thread-9" })).toThrow(/paused run/);
    expect(() => pausedRunOfJson("{not json", { threadId: "thread-9" })).toThrow(/thread-9/);
  });
});
