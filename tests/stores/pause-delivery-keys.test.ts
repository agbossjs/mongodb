/**
 * agbossjs/agboss#81: the keys of the notice delivery's Mongo statements that no mutant of Stryker
 * drops (it empties a whole literal, never removes one key), each proved by a test that fails
 * without it. Each step of a delivery is of the one mailbox it names — a second mailbox that holds
 * the same claim token (a hand-made row; a token is random) stays as it was —, a claim takes only
 * what has a notice left to deliver, and each step leaves the whole mailbox as it says: the
 * attempts, the problem and the claim.
 */
import { PauseNoticeKind, type PauseMailbox, type PauseNoticeClaim } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { beforeEach, describe, expect, it } from "vitest";
import { MongoPausedExecutionRepository } from "../../src/index.js";
import { appendNotice, mailboxesOf, mailboxIdOf } from "../../src/stores/paused/pause-mailboxes.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { NINE } from "../support/pauses.js";
import { insertMailboxRow } from "../support/pause-rows.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();
const AUDIT = "listener:audit";
const TOKEN = "claim-token";
const UNTIL = new Date(NINE.getTime() + 60_000);
const NEXT = new Date(NINE.getTime() + 5_000);
const WRITTEN = new Date(NINE.getTime() - 3_600_000);

beforeEach(() => emptyAll(database.url()));

const storeOn = () =>
  new MongoPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());

const notice = (seq: number) => ({ seq, kind: PauseNoticeKind.Opened, writtenAt: WRITTEN });

/** A claimed mailbox row of the pause `id`: two notices, one acknowledged-to-be, held under `TOKEN`. */
const claimedRow = (id: string, fields: Record<string, unknown> = {}) =>
  insertMailboxRow(connectionTo(database.url()).db, id, {
    ...{ headWrittenAt: WRITTEN, nextAttemptAt: NINE, notices: [notice(1), notice(2)] },
    ...{ attempts: 3, claimToken: TOKEN, claimedUntil: UNTIL, problem: "boom" },
    ...fields,
  });

const rowOf = (id: string) =>
  mailboxesOf(connectionTo(database.url()).db).findOne(
    { _id: mailboxIdOf("default", id, AUDIT) },
    { projection: { _id: 0, notices: 0, tenantId: 0, pauseId: 0, recipient: 0 } },
  );

/** The claim of `id`'s mailbox under `TOKEN`, as a worker holds it. */
const claimOf = (id: string): PauseNoticeClaim => {
  const mailbox: PauseMailbox = {
    ...{ tenantId: "default", pauseId: id, recipient: AUDIT, notices: [], delivered: 0 },
    ...{ attempts: 3, nextAttemptAt: NINE, isDead: false },
  };
  return { mailbox, token: TOKEN, until: UNTIL };
};

describe("agbossjs/agboss#81: a claim takes what has a notice left to deliver", () => {
  it("a mailbox that has delivered every notice is not claimed, though it is due", async () => {
    await claimedRow("done", { delivered: 2, claimToken: null, claimedUntil: null });

    expect(await storeOn().claimNoticesDue(NINE, 5, seconds(60), [AUDIT])).toEqual([]);
  });
});

describe("agbossjs/agboss#81: an acknowledgement", () => {
  it("is of the mailbox it names, whatever other mailbox holds its token", async () => {
    await claimedRow("first");
    await claimedRow("second");

    const next = await storeOn().ackNotice(claimOf("second"), NINE);

    expect(next?.mailbox.pauseId).toBe("second");
    expect(await rowOf("first")).toMatchObject({ delivered: 0, attempts: 3, problem: "boom" });
    expect(await rowOf("second")).toMatchObject({ delivered: 1, attempts: 0 });
  });

  it("with a notice left: the next is the head and due now, attempts and problem start over, the claim stays", async () => {
    await claimedRow("more");

    const next = await storeOn().ackNotice(claimOf("more"), NINE);

    expect(next).toMatchObject({ token: TOKEN, until: UNTIL });
    expect(next?.mailbox).toMatchObject({ pauseId: "more", recipient: AUDIT, delivered: 1 });
    expect(await rowOf("more")).toEqual({
      ...{ delivered: 1, attempts: 0, problem: null, isDead: false },
      ...{ headWrittenAt: WRITTEN, nextAttemptAt: NINE },
      ...{ claimToken: TOKEN, claimedUntil: UNTIL },
    });
  });

  it("of the last notice: nothing is due, the claim is released, the answer is none", async () => {
    await claimedRow("last", { delivered: 1 });

    expect(await storeOn().ackNotice(claimOf("last"), NINE)).toBeUndefined();

    expect(await rowOf("last")).toMatchObject({
      ...{ delivered: 2, attempts: 0, problem: null, nextAttemptAt: null },
      ...{ claimToken: null, claimedUntil: null },
    });
  });
});

describe("agbossjs/agboss#81: a renewal", () => {
  it("is of the mailbox it names, and answers the mailbox as it is", async () => {
    await claimedRow("first");
    await claimedRow("second");
    const later = new Date(NINE.getTime() + 120_000);

    const renewed = await storeOn().renewNotice(claimOf("second"), NINE, seconds(120));

    expect(renewed).toMatchObject({ token: TOKEN, until: later });
    expect(renewed?.mailbox).toMatchObject({ pauseId: "second", recipient: AUDIT, attempts: 3 });
    expect(await rowOf("first")).toMatchObject({ claimedUntil: UNTIL });
    expect(await rowOf("second")).toMatchObject({ claimedUntil: later, claimToken: TOKEN });
  });
});

describe("agbossjs/agboss#81: a failed attempt and a set-aside", () => {
  it("a retry is of the mailbox it names, counts the attempt, says why and lets the claim go", async () => {
    await claimedRow("first");
    await claimedRow("second");

    expect(await storeOn().retryNotice(claimOf("second"), NEXT, "send-failed")).toBe(true);

    expect(await rowOf("first")).toMatchObject({ attempts: 3, problem: "boom", claimToken: TOKEN });
    expect(await rowOf("second")).toMatchObject({
      ...{ attempts: 4, problem: "send-failed", nextAttemptAt: NEXT, isDead: false },
      ...{ claimToken: null, claimedUntil: null },
    });
  });

  it("a give-up is of the mailbox it names, marks it dead, says why and lets the claim go", async () => {
    await claimedRow("first");
    await claimedRow("second");

    expect(await storeOn().setAsideNotices(claimOf("second"), NINE, "gave-up")).toBe(true);

    expect(await rowOf("first")).toMatchObject({ isDead: false, problem: "boom" });
    expect(await rowOf("second")).toMatchObject({
      ...{ isDead: true, problem: "gave-up", claimToken: null, claimedUntil: null },
      ...{ attempts: 3 },
    });
  });

  it("the stale look sets aside only a mailbox with a notice left, and lets its claim go", async () => {
    await claimedRow("stale", { claimedUntil: new Date(NINE.getTime() - 1000) });
    await claimedRow("delivered", {
      ...{ claimedUntil: new Date(NINE.getTime() - 1000), delivered: 2 },
    });

    const set = await storeOn().setAsideStaleNoticesBefore(NINE, NINE, "stale-head", 10);

    expect(set.map((one) => one.pauseId)).toEqual(["stale"]);
    expect(await rowOf("stale")).toMatchObject({
      ...{ isDead: true, problem: "stale-head", claimToken: null, claimedUntil: null },
    });
    expect(await rowOf("delivered")).toMatchObject({ isDead: false, claimToken: TOKEN });
  });
});

describe("agbossjs/agboss#81: the first notice of a mailbox, and one that follows", () => {
  it("makes the mailbox with nothing claimed, nothing wrong, due now", async () => {
    const { db } = connectionTo(database.url());

    await appendNotice(
      db,
      undefined,
      { tenantId: "default", pauseId: "new" },
      {
        ...{ recipient: AUDIT, at: NEXT },
        notice: { kind: PauseNoticeKind.Opened, writtenAt: NEXT },
      },
    );

    expect(await mailboxesOf(db).findOne({ _id: mailboxIdOf("default", "new", AUDIT) })).toEqual({
      ...{ _id: mailboxIdOf("default", "new", AUDIT), tenantId: "default", pauseId: "new" },
      ...{ recipient: AUDIT, delivered: 0, attempts: 0, isDead: false, problem: null },
      ...{ claimToken: null, claimedUntil: null, headWrittenAt: NEXT, nextAttemptAt: NEXT },
      notices: [{ seq: 1, kind: PauseNoticeKind.Opened, writtenAt: NEXT }],
    });
  });

  it("to a mailbox with nothing left to deliver makes it the head: attempts and problem start over", async () => {
    await claimedRow("idle", {
      ...{ delivered: 2, claimToken: null, claimedUntil: null, nextAttemptAt: null },
      ...{ headWrittenAt: null },
    });
    const { db } = connectionTo(database.url());

    await appendNotice(
      db,
      undefined,
      { tenantId: "default", pauseId: "idle" },
      {
        ...{ recipient: AUDIT, at: NEXT },
        notice: { kind: PauseNoticeKind.Closed, writtenAt: NEXT },
      },
    );

    expect(await rowOf("idle")).toEqual({
      ...{ delivered: 2, attempts: 0, problem: null, isDead: false },
      ...{ headWrittenAt: NEXT, nextAttemptAt: NEXT, claimToken: null, claimedUntil: null },
    });
  });
});
