/**
 * agbossjs/agboss#906 D4, one rule for every stored JSON text: a text that is not JSON (cut off, empty,
 * damaged) is refused by the ids of its row — never the text, never the parser's message (it quotes the
 * text), never a tenant, and no `cause`. A paused run, a pause, an answer-log entry and a history record alike.
 */
import { inspect } from "node:util";
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import {
  Collections,
  MongoExecutionHistoryRepository,
  MongoPausedExecutionRepository,
} from "../../src/index.js";
import { idOf } from "../../src/stores/keys.js";
import { testDatabase } from "../support/database.js";
import { connectionTo, recordsOn } from "../support/stores.js";
import { oldPause } from "./pause-names-0.1.0.fixtures.js";

const database = testDatabase();
const SECRET = "ssn-078-05-1120";

interface Document {
  _id: string;
  [field: string]: unknown;
}

/** Texts a damaged database could hold: cut off inside a secret value, empty, a bare secret, a JSON prefix with trailing junk. */
const DAMAGED: readonly (readonly [string, string])[] = [
  ["a truncated JSON text", `{"startInput":{"ssn":"${SECRET}`],
  ["an empty text", ""],
  ["a bare secret", SECRET],
  ["a JSON value with a secret behind it", `{"a":1} ${SECRET}`],
];

async function refusal(read: () => Promise<unknown>, ids: readonly string[]): Promise<void> {
  const error: unknown = await read().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Error)) throw new TypeError("it was read, or nothing Error-like thrown");
  expect(error).not.toBeInstanceOf(SyntaxError);
  expect(error.message).toContain("is not readable");
  expect(error.message).toContain("the text is not valid JSON");
  for (const id of ids) expect(error.message).toContain(id);
  expect(error.message).not.toContain("tenantId");
  expect(error.cause).toBeUndefined();
  const shown = inspect(error, { depth: 12 });
  expect(shown).not.toContain(SECRET);
  expect(shown).not.toContain("startInput");
  expect(shown).not.toMatch(/JSON\.parse|Unexpected|position \d|in JSON/);
}

describe.each(DAMAGED)("%s", (_name, text) => {
  it("in a paused run", async () => {
    const thread = `thread-${String(text.length)}`;
    await connectionTo(database.url())
      .db.collection<Document>(Collections.PausedExecutions)
      .insertOne({
        _id: idOf("acme", thread),
        runId: "run-1",
        run: text,
        workflowVersion: "1.0.0",
        configHash: "hash",
        pausedAt: new Date(0),
      });
    const pauses = new MongoPausedExecutionRepository(
      connectionTo(database.url()),
      new VirtualClock(),
    );

    await refusal(
      () => pauses.findByTenantIdAndThreadId("acme", thread),
      [`threadId ${thread}`, "runId run-1", "a stored paused run"],
    );
  });

  it("in a pause: its record text and its closing text", async () => {
    const { status, resolution, resolvedAt } = oldPause;
    for (const damaged of ["record", "closing"] as const) {
      const id = `p-${damaged}-${String(text.length)}`;
      await connectionTo(database.url())
        .db.collection<Document>(Collections.Pauses)
        .insertOne({
          _id: idOf("default", id),
          tenantId: "default",
          pauseId: id,
          rootExecutionId: "run-1",
          stepKey: `run-1:s:${id}`,
          seq: text.length + (damaged === "record" ? 0 : 1000),
          status,
          isSent: true,
          resolvedAt: new Date(resolvedAt),
          record: damaged === "record" ? text : JSON.stringify({ ...oldPause, pauseId: id }),
          closing:
            damaged === "closing" ? text : JSON.stringify({ status, resolution, resolvedAt }),
        });
      const pauses = new MongoPausedExecutionRepository(
        connectionTo(database.url()),
        new VirtualClock(),
      );

      await refusal(
        () => pauses.findByTenantIdAndPauseId("default", id),
        [`pauseId ${id}`, "a stored pause"],
      );
    }
  });

  it("in an answer-log entry", async () => {
    const root = `root-${String(text.length)}`;
    await connectionTo(database.url())
      .db.collection<Document>(Collections.PauseAnswers)
      .insertOne({
        _id: idOf("default", root, "run-1:s:1"),
        tenantId: "default",
        rootExecutionId: root,
        askedAt: "2026-01-05T09:00:00.000Z",
        seq: text.length,
        record: text,
      });

    await refusal(
      () => recordsOn(database.url()).findPauseAnswersByTenantIdAndRootExecutionId("default", root),
      [`executionId ${root}`, "a stored pause answer"],
    );
  });

  it("in a history record", async () => {
    const id = `run-${String(text.length)}`;
    await connectionTo(database.url())
      .db.collection<Document>(Collections.ExecutionHistory)
      .insertOne({
        _id: idOf("default", id),
        tenantId: "default",
        executionId: id,
        threadId: "t-1",
        startedAt: new Date("2026-01-05T09:00:00Z"),
        endedAt: null,
        record: text,
      });
    const history = new MongoExecutionHistoryRepository(connectionTo(database.url()));

    await refusal(
      () => history.findByTenantIdAndExecutionId("default", id),
      [`executionId ${id}`, "a stored execution history record"],
    );
  });
});
