/**
 * agbossjs/agboss#1213: the framework's JSON records a store keeps — a pause read back by the core,
 * a paused run whose non-finite numbers JSON cannot hold are tagged and restored.
 */
import { type PausedExecution, type PauseRecord } from "@agboss/core";
import { StoredNamesUnreadableError } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import {
  pauseAnswerOfJson,
  pausedRunJsonOf,
  pausedRunOfJson,
  pauseRecordOf,
} from "../../src/stores/framework-json.js";
import { answerOf } from "../support/pause-answers.js";
import { pauseOf } from "../support/pauses.js";
import { pausedRunOf } from "../support/paused-run.js";

// read in a test, not at the import: a mutant of the reading that fails here must fail a test, which kills it,
// not the import of the file, which Stryker leaves out of the score (agbossjs/mongodb#103)
const base = (): PausedExecution["run"] => pausedRunOfJson(pausedRunJsonOf(pausedRunOf()));
const run = (extra: Partial<PausedExecution["run"]>): PausedExecution["run"] => ({
  ...base(),
  ...extra,
});

const pause: PauseRecord = pauseOf("pause-1", "step-1");

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
    const answer = pauseAnswerOfJson(JSON.stringify(answerOf("manager-17")), {
      executionId: "child-7",
    });

    expect(answer).toMatchObject({ executionId: "child-7", actor: { id: "manager-17" } });
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
