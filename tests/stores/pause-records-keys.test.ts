/**
 * agbossjs/agboss#81: the keys of the pause store's Mongo statements and documents that no mutant
 * of Stryker drops (it empties a whole literal, never removes one key), each proved by a test that
 * fails without it. A statement is of the pause or paused run it names, and of the state it is for
 * (a pause taken is one that was resolved); a notice written once is once for its own pause; a
 * replacement is pending and unsent whatever it was handed; the documents keep the fields the
 * scans and the pages read them by.
 *
 * Keys left as they are, no test can tell them (the sweep's equivalents): `...step` of the
 * `$setOnInsert` document of `findOrCreatePause` (an upsert inserts the equalities of its filter,
 * which are those three fields, whatever the update sets), and `isSent: false` of the filter that
 * marks a pause sent (the read before it, in the same snapshot, found it unsent: a concurrent mark
 * is the transaction's write conflict, never a filter that misses).
 */
import { ExpiryProblem, PauseResolution, PauseStatus } from "@agboss/core";
import { NO_RECIPIENTS, PauseNoticeKind } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { Collections, MongoPausedExecutionRepository } from "../../src/index.js";
import { pausedRunOfJson } from "../../src/stores/framework-json.js";
import { idOf } from "../../src/stores/keys.js";
import { insertPause } from "../../src/stores/paused/pause-documents.js";
import { mailboxesOf } from "../../src/stores/paused/pause-mailboxes.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { currentPausedRun } from "../support/paused-run.js";
import { ANSWER, NINE, pauseOf } from "../support/pauses.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();

beforeEach(() => emptyAll(database.url()));

const clock = new VirtualClock();
const storeOn = () => new MongoPausedExecutionRepository(connectionTo(database.url()), clock);
const dbOf = () => connectionTo(database.url()).db;
const pauses = () =>
  dbOf().collection<{ _id: string } & Record<string, unknown>>(Collections.Pauses);
const rowOf = (pauseId: string) =>
  pauses().findOne({ _id: idOf("default", pauseId) }, { projection: { _id: 0, record: 0 } });

interface PausedRow {
  _id: string;
  runId: string;
  run: string;
  workflowVersion: string;
  configHash: string;
  pausedAt?: Date;
}
const pausedRuns = () => dbOf().collection<PausedRow>(Collections.PausedExecutions);

describe("agbossjs/agboss#81: a paused run", () => {
  it("is saved with the time it paused at, the clock's", async () => {
    const run = pausedRunOfJson(
      JSON.stringify({
        ...currentPausedRun,
        ...{ threadId: "thread-1", tenantId: "acme", runId: "run-9", turnId: "turn-1" },
      }),
    );

    await storeOn().save({ run, workflowVersion: "1.0.0", configHash: "hash" });

    expect(await pausedRuns().findOne({ _id: idOf("acme", "thread-1") })).toMatchObject({
      ...{ runId: "run-9", workflowVersion: "1.0.0", configHash: "hash" },
      pausedAt: clock.now(),
    });
  });

  it("is deleted by its run on its own thread: another thread's of the same run stays", async () => {
    for (const thread of ["t2", "t1"])
      await pausedRuns().insertOne({
        ...{ _id: idOf("default", thread), runId: "r", run: "{}" },
        ...{ workflowVersion: "1", configHash: "h" },
      });

    await storeOn().deleteByTenantIdAndThreadIdAndRunId("default", "t1", "r");

    expect(await pausedRuns().distinct("_id")).toEqual([idOf("default", "t2")]);
  });
});

describe("agbossjs/agboss#81: a pause taken", () => {
  it("is one that was resolved, and the pause named: a pending one, or another, is not marked", async () => {
    const store = storeOn();
    await store.findOrCreateByStepKey(pauseOf("answered", "run-1:s:1"));
    await store.findOrCreateByStepKey(pauseOf("waiting", "run-1:s:2"));
    await store.findOrCreateByStepKey(pauseOf("other", "run-1:s:3"));
    await store.markSentByTenantIdAndPauseId("default", "answered", NO_RECIPIENTS);
    await store.markSentByTenantIdAndPauseId("default", "other", NO_RECIPIENTS);
    await store.resolveByTenantIdAndPauseId("default", "answered", ANSWER, NINE, NO_RECIPIENTS);
    await store.resolveByTenantIdAndPauseId("default", "other", ANSWER, NINE, NO_RECIPIENTS);

    await store.markTakenByTenantIdAndPauseId("default", "waiting");
    await store.markTakenByTenantIdAndPauseId("default", "answered");

    expect(await rowOf("waiting")).toMatchObject({ status: PauseStatus.Pending });
    expect(await rowOf("answered")).toMatchObject({ status: PauseStatus.Taken });
    expect(await rowOf("other")).toMatchObject({ status: PauseStatus.Resolved });
  });

  it("decided at once is Taken, with the closing it keeps; a pause that is not pending is not decided", async () => {
    const store = storeOn();
    await store.findOrCreateByStepKey(pauseOf("decided"));

    expect(await store.decideByTenantIdAndPauseId("default", "decided", ANSWER, NINE)).toBe(true);
    expect(await store.decideByTenantIdAndPauseId("default", "decided", ANSWER, NINE)).toBe(false);

    const row = await rowOf("decided");
    expect(row).toMatchObject({ status: PauseStatus.Taken, resolvedAt: NINE });
    expect(JSON.parse(String(row?.closing))).toEqual({
      status: PauseStatus.Taken,
      resolution: PauseResolution.Decided,
      resolvedAt: NINE.toISOString(),
      answer: ANSWER,
    });
  });

  it("a pause expired for a problem keeps it in its closing", async () => {
    const store = storeOn();
    const at = new Date(NINE.getTime() + 60_000);
    await store.findOrCreateByStepKey({ ...pauseOf("late"), expiresAt: at.toISOString() });

    const expired = await store.expireByTenantIdAndPauseId(
      "default",
      "late",
      { problem: ExpiryProblem.HandlerFailed },
      at,
      NO_RECIPIENTS,
    );

    expect(expired).toMatchObject({ expiryProblem: ExpiryProblem.HandlerFailed });
    expect(JSON.parse(String((await rowOf("late"))?.closing))).toEqual({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Expired,
      resolvedAt: at.toISOString(),
      expiryProblem: ExpiryProblem.HandlerFailed,
    });
  });
});

describe("agbossjs/agboss#81: a notice written once", () => {
  it("is once for its own pause: another pause's notice of the kind does not stand for it", async () => {
    const store = storeOn();
    await store.findOrCreateByStepKey(pauseOf("one", "run-1:s:1"));
    await store.findOrCreateByStepKey(pauseOf("two", "run-1:s:2"));
    const recipients = { listeners: ["audit"] };
    for (const id of ["one", "two"])
      await store.markSentByTenantIdAndPauseId("default", id, recipients);
    const once = (id: string, tenantId = "default") =>
      store.noticeOnceByTenantIdAndPauseId(
        tenantId,
        id,
        PauseNoticeKind.Extended,
        { expiresAt: "2026-01-05T10:00:00.000Z" },
        NINE,
        recipients,
      );

    expect(await once("one")).toBe(true);
    expect(await once("one")).toBe(false);
    expect(await once("two")).toBe(true);

    expect(
      await mailboxesOf(dbOf()).countDocuments({ "notices.kind": PauseNoticeKind.Extended }),
    ).toBe(2);
  });

  it("is once for its own tenant: the same pause id of another tenant is another pause", async () => {
    const store = storeOn();
    const recipients = { listeners: ["audit"] };
    for (const tenantId of ["acme", "globex"]) {
      await store.findOrCreateByStepKey({ ...pauseOf("same"), tenantId });
      await store.markSentByTenantIdAndPauseId(tenantId, "same", recipients);
    }
    const once = (tenantId: string) =>
      store.noticeOnceByTenantIdAndPauseId(
        tenantId,
        "same",
        PauseNoticeKind.Extended,
        { expiresAt: "2026-01-05T10:00:00.000Z" },
        NINE,
        recipients,
      );

    expect(await once("acme")).toBe(true);
    expect(await once("globex")).toBe(true);
  });
});

describe("agbossjs/agboss#81: a reassignment's replacement", () => {
  it("is pending, unsent, asked now and from the pause it replaces, whatever it was handed", async () => {
    const store = storeOn();
    await store.findOrCreateByStepKey(pauseOf("before"));
    const hostile = {
      ...{ pauseId: "after", assignees: ["alice"] },
      ...{ status: PauseStatus.Resolved, isSent: true, askedAt: "2020-01-01T00:00:00.000Z" },
      reassignedFrom: "someone-else",
    };

    const made = await store.reassignByTenantIdAndPauseId(
      "default",
      "before",
      hostile,
      NINE,
      NO_RECIPIENTS,
    );

    expect(made).toMatchObject({
      ...{ pauseId: "after", status: PauseStatus.Pending, isSent: false },
      ...{ askedAt: NINE.toISOString(), reassignedFrom: "before" },
    });
    expect(await rowOf("after")).toMatchObject({
      ...{ status: PauseStatus.Pending, isSent: false, reassignedFrom: "before" },
      ...{ askedAt: NINE, channel: "refund-approval-channel" },
    });
  });
});

describe("agbossjs/agboss#81: the fields a pause document keeps beside its record", () => {
  it("a new pause is stored with its target, its tenant, its tree and its step", async () => {
    await storeOn().findOrCreateByStepKey(pauseOf("fresh"));

    expect(await rowOf("fresh")).toMatchObject({
      ...{ tenantId: "default", rootExecutionId: "run-1", stepKey: "run-1:fresh:1" },
      ...{ pauseId: "fresh", target: "refund-tool-approval", status: PauseStatus.Pending },
    });
  });

  it("a pause inserted by a replacement has them too", async () => {
    const connection = connectionTo(database.url());
    const session = connection.client.startSession();
    try {
      await insertPause(connection.db, session, pauseOf("inserted"));
    } finally {
      await session.endSession();
    }

    expect(await rowOf("inserted")).toMatchObject({
      ...{ tenantId: "default", rootExecutionId: "run-1", stepKey: "run-1:inserted:1" },
      ...{ pauseId: "inserted", target: "refund-tool-approval" },
    });
  });
});
