import { PauseAnswerer, PauseStatus } from "@agboss/core";
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
import { oldAnswerLogEntry, oldHistoryRecord, oldPause } from "./pause-names-0.1.0.fixtures.js";

/**
 * agbossjs/agboss#934 AC3: what 0.1.0 kept in MongoDB reads back with the new names — documents
 * inserted as 0.1.0 wrote them (a contract case cannot: the writer rebuilds the JSON). A pause's
 * `answeredBy` (the kind) is its `answerer`, its answer's `answerer` (the person) is `answeredBy`, a
 * log entry's `answeredBy` / `responder` are `answerer` / `answeredBy`, a kept history record's
 * pauses and its children's the same. Nothing is migrated.
 */
const database = testDatabase();

describe("AC3: a MongoDB database written by 0.1.0", () => {
  it("a Resolved pause's answer keeps its person (answeredBy) and its record says who may answer (answerer)", async () => {
    const { answer, status, resolution, resolvedAt, ...created } = oldPause;
    const { db } = connectionTo(database.url());
    await db.collection<{ _id: string; [field: string]: unknown }>(Collections.Pauses).insertOne({
      _id: idOf("default", "p1"),
      tenantId: "default",
      pauseId: "p1",
      rootExecutionId: "run-1",
      stepKey: "run-1:s:1",
      seq: 1,
      status,
      isSent: true,
      resolvedAt: new Date(resolvedAt),
      record: JSON.stringify({ ...created, status: "pending" }),
      closing: JSON.stringify({ status, resolution, resolvedAt, answer }),
    });
    const pauses = new MongoPausedExecutionRepository(
      connectionTo(database.url()),
      new VirtualClock(),
    );

    const pause = await pauses.findByTenantIdAndPauseId("default", "p1");

    expect(pause).toMatchObject({
      status: PauseStatus.Resolved,
      answerer: PauseAnswerer.Channel,
      answer: { decision: { approved: true }, answeredBy: "manager-17" },
    });
    expect(pause).not.toHaveProperty("answeredBy");
    expect(pause?.answer).not.toHaveProperty("answerer");
  });

  it("a log entry: answerer = the kind, answeredBy the person", async () => {
    const { db } = connectionTo(database.url());
    await db
      .collection<{ _id: string; [field: string]: unknown }>(Collections.PauseAnswers)
      .insertOne({
        _id: idOf("default", "run-1", "run-1:s:1"),
        tenantId: "default",
        rootExecutionId: "run-1",
        askedAt: "2026-01-05T09:00:00.000Z",
        seq: 1,
        record: JSON.stringify(oldAnswerLogEntry),
      });

    const [entry] = await recordsOn(database.url()).findPauseAnswersByTenantIdAndRootExecutionId(
      "default",
      "run-1",
    );

    expect(entry).toMatchObject({
      answerer: PauseAnswerer.Channel,
      answeredBy: "manager-17",
      responder: "manager-17",
    });
  });

  it("a kept history record and its children's pauses are normalised", async () => {
    const { db } = connectionTo(database.url());
    await db
      .collection<{ _id: string; [field: string]: unknown }>(Collections.ExecutionHistory)
      .insertOne({
        _id: idOf("default", "run-1"),
        tenantId: "default",
        executionId: "run-1",
        threadId: "t-1",
        startedAt: new Date("2026-01-05T09:00:00Z"),
        endedAt: null,
        record: JSON.stringify(oldHistoryRecord),
      });
    const history = new MongoExecutionHistoryRepository(connectionTo(database.url()));

    const record = await history.findByTenantIdAndExecutionId("default", "run-1");

    expect([
      record?.pauses[0],
      record?.children[0]?.pauses[0],
      record?.children[0]?.children[0]?.pauses[0],
    ]).toMatchObject([
      { answerer: PauseAnswerer.Channel, answeredBy: "manager-17" },
      { answerer: PauseAnswerer.ThreadOwner, answeredBy: "alice" },
      { answerer: PauseAnswerer.Channel, answeredBy: "bob" },
    ]);
  });
});
