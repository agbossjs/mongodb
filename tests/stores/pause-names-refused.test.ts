/**
 * agbossjs/agboss#934 D1 / D2: a stored value that is not the shape 0.1.1 writes is refused — in the history record (its pauses and its children's, at any depth), in the answer log
 * and in a pause's embedded answer alike — with `StoreError.UnreadableRecord` naming the record's id
 * and the field, never the value. Documents are inserted as a damaged database would hold them.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { VirtualClock } from "@agboss/core/testing";
import {
  Collections,
  MongoExecutionHistoryRepository,
  MongoPausedExecutionRepository,
} from "../../src/index.js";
import { idOf } from "../../src/stores/keys.js";
import { testDatabase } from "../support/database.js";
import { connectionTo, recordsOn } from "../support/stores.js";
import { pauseOf } from "../support/pauses.js";
import { answerEntry, historyRecord, historyRecordWith, leafOf } from "./stored-rows.fixtures.js";

const database = testDatabase();
const SECRET = "sk-live-PLANTED-SECRET-934";

/** Everything an error shows: message, stack, the whole cause chain. */
const shown = (error: unknown): string => inspect(error, { depth: 12 });

/** The refusal of `read`: the typed error, its message naming `id` and `field`, no value anywhere. */
async function refusal(read: () => unknown, id: string, field: string): Promise<void> {
  const error = await Promise.resolve()
    .then(read)
    .then(
      () => new Error("it was read"),
      (thrown: unknown) => thrown,
    );
  if (!(error instanceof Error)) throw new TypeError("nothing was thrown");
  expect(error.name).toBe("StoreError.UnreadableRecord");
  expect(error.message).toContain(id);
  expect(error.message).toContain(field);
  expect(shown(error)).not.toContain(SECRET);
  expect(shown(error)).not.toContain("<junk>");
}

const entry = (change: Record<string, unknown>): unknown => ({
  ...answerEntry("run-1", "delegate", "manager-17"),
  ...change,
});

/** Entries the reader refuses, with the field the refusal names. */
const BAD_ENTRIES: readonly (readonly [string, Record<string, unknown>, string])[] = [
  ["an entry with a junk respondent", { respondent: "<junk>" }, "respondent"],
  ["an entry whose actor is a number", { actor: 42 }, "actor"],
  ["an entry with no respondent, the 0.1.0 way", { respondent: undefined }, "respondent"],
  ["an entry whose target is a number", { target: 42 }, "target"],
];

interface Document {
  _id: string;
  [field: string]: unknown;
}

const historyWith = async (record: unknown): Promise<MongoExecutionHistoryRepository> => {
  const { db } = connectionTo(database.url());
  await db.collection<Document>(Collections.ExecutionHistory).deleteMany({});
  await db.collection<Document>(Collections.ExecutionHistory).insertOne({
    _id: idOf("default", "run-1"),
    tenantId: "default",
    executionId: "run-1",
    threadId: "t-1",
    startedAt: new Date("2026-01-05T09:00:00Z"),
    endedAt: null,
    record: JSON.stringify(record),
  });
  return new MongoExecutionHistoryRepository(connectionTo(database.url()));
};

let sequence = 0;
const answerLogWith = async (record: unknown): Promise<string> => {
  sequence += 1;
  const root = `root-${String(sequence)}`;
  await connectionTo(database.url())
    .db.collection<Document>(Collections.PauseAnswers)
    .insertOne({
      _id: idOf("default", root, "run-1:s:1"),
      tenantId: "default",
      rootExecutionId: root,
      askedAt: "2026-01-05T09:00:00.000Z",
      seq: sequence,
      record: JSON.stringify(record),
    });
  return root;
};

describe("D1: the same entry is refused on the history path and on the answer-log path", () => {
  it.each(BAD_ENTRIES)("%s", async (_name, change, field) => {
    const bad = entry(change);
    const history = await historyWith({ ...historyRecord, pauses: [bad] });
    const root = await answerLogWith(bad);

    await refusal(
      () => history.findByTenantIdAndExecutionId("default", "run-1"),
      "run-1",
      `pauses.0.${field}`,
    );
    await refusal(
      () => recordsOn(database.url()).findPauseAnswersByTenantIdAndRootExecutionId("default", root),
      "run-1",
      field,
    );
  });

  it("an entry a child's child holds is refused at its path", async () => {
    const history = await historyWith(
      historyRecordWith((tree) => {
        leafOf(tree).pauses = [entry({ respondent: "<junk>" })];
      }),
    );

    await refusal(
      () => history.findAllByExecutionId("run-1"),
      "run-1",
      "children.0.children.0.pauses.0.respondent",
    );
  });
});

describe("D2: an unreadable history record names its id and the field, nothing else", () => {
  it.each([
    ["a null entry", { pauses: [null] }, "pauses.0"],
    ["an entry that is a text", { pauses: [SECRET] }, "pauses.0"],
    ["a status that is an object", { status: { t: SECRET } }, "status"],
    ["a startedAt that is a number", { startedAt: 42 }, "startedAt"],
    ["a spend that is a text", { spend: SECRET }, "spend"],
    ["a step that is a number", { steps: [42] }, "steps.0"],
  ])("%s", async (_name, change, field) => {
    const history = await historyWith({ ...historyRecord, ...change });

    await refusal(() => history.findByTenantIdAndExecutionId("default", "run-1"), "run-1", field);
  });
});

describe("D1 / D2: a pause's embedded answer and the answer log", () => {
  const pauseWith = async (
    answer: unknown,
    id: string,
  ): Promise<MongoPausedExecutionRepository> => {
    const [status, resolution, resolvedAt] = ["resolved", "replied", "2026-01-05T09:05:00.000Z"];
    const created = { ...pauseOf(id, `run-1:s:${id}`), status: "pending" };
    await connectionTo(database.url())
      .db.collection<Document>(Collections.Pauses)
      .insertOne({
        _id: idOf("default", id),
        tenantId: "default",
        pauseId: id,
        rootExecutionId: "run-1",
        stepKey: `run-1:s:${id}`,
        seq: ++sequence,
        status,
        isSent: true,
        resolvedAt: new Date(resolvedAt),
        record: JSON.stringify(created),
        closing: JSON.stringify({ status, resolution, resolvedAt, answer }),
      });
    return new MongoPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());
  };

  it.each([
    ["an actor that is a number", { decision: 1, actor: 42 }, "answer.actor"],
    ["an answeredBy of 0.1.0", { decision: 1, answeredBy: "manager-17" }, "answer.answeredBy"],
    ["a text instead of the answer", SECRET, "answer"],
  ])("a pause whose answer has %s names the pause and the field", async (_name, answer, field) => {
    const id = `p-${String((sequence += 1))}`;
    const pauses = await pauseWith(answer, id);

    await refusal(() => pauses.findByTenantIdAndPauseId("default", id), `pauseId ${id}`, field);
  });

  it("an answer-log entry whose role is an object names the execution and the field", async () => {
    const root = await answerLogWith(entry({ role: { t: SECRET } }));

    await refusal(
      () => recordsOn(database.url()).findPauseAnswersByTenantIdAndRootExecutionId("default", root),
      "run-1",
      "role",
    );
  });
});
