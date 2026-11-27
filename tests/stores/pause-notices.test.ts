/**
 * agbossjs/agboss#938 on MongoDB: what the contract cannot see — the append's pipeline on a
 * mailbox a version never wrote, the BSON type of the head's time, a transaction the driver runs
 * again, texts that start with `$`, concurrent `noticeOnce` calls, a cursor over deleted rows.
 */
import { PauseNoticeKind, NO_RECIPIENTS, type PauseRecipients } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { PauseResolution, type PauseRecord } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { MongoServerError } from "mongodb";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Collections,
  MongoPausedExecutionRepository,
  type MongoTransaction,
} from "../../src/index.js";
import type { PlannedNotice } from "@agboss/core/stores";
import { mailboxIdOf, mailboxesOf } from "../../src/stores/paused/pause-mailboxes.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { ANSWER, NINE, pauseOf } from "../support/pauses.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();

// every case starts on empty collections: a claim or a page reads the whole store
beforeEach(() => emptyAll(database.url()));
const AUDIT: PauseRecipients = { listeners: ["audit"] };
const BOXES: PauseRecipients = { channel: "approvals", listeners: ["audit", "ledger"] };

const Notices = z.array(z.object({ seq: z.number(), kind: z.string() }));
const noticesOf = (box: { notices?: unknown } | null) => Notices.parse(box?.notices ?? []);

const storeOn = (): MongoPausedExecutionRepository =>
  new MongoPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());

const mailboxOf = (pauseId: string, recipient: string) =>
  mailboxesOf(connectionTo(database.url()).db).findOne({
    _id: mailboxIdOf("default", pauseId, recipient),
  });

/** A sent pause `id`, its `opened` written. */
async function sentPause(id: string, recipients = AUDIT): Promise<MongoPausedExecutionRepository> {
  const store = storeOn();
  await store.findOrCreateByStepKey(pauseOf(id));
  await store.markSentByTenantIdAndPauseId("default", id, recipients);
  return store;
}

/** A store whose first change throws what a write conflict throws, after it appended its notices. */
class ConflictedOnce extends MongoPausedExecutionRepository {
  runs = 0;

  protected override async appendNotices(
    transaction: MongoTransaction,
    pause: PauseRecord,
    notices: readonly PlannedNotice[],
  ): Promise<void> {
    await super.appendNotices(transaction, pause, notices);
    this.runs += 1;
    if (this.runs === 1)
      throw new MongoServerError({
        message: "write conflict",
        errorLabels: ["TransientTransactionError"],
      });
  }
}

describe("MongoPausedExecutionRepository notices", () => {
  it("a transition retried by the driver (TransientTransactionError) appends its notice once", async () => {
    await sentPause("p-retried");
    const store = new ConflictedOnce(connectionTo(database.url()), new VirtualClock());

    const resolved = await store.resolveByTenantIdAndPauseId(
      "default",
      "p-retried",
      ANSWER,
      new Date("2026-01-05T09:05:00.000Z"),
      AUDIT,
    );

    expect(resolved?.resolution).toBe(PauseResolution.Replied);
    expect(store.runs).toBe(2);
    const box = await mailboxOf("p-retried", "listener:audit");
    expect(noticesOf(box).map((notice) => [notice.seq, notice.kind])).toEqual([
      [1, PauseNoticeKind.Opened],
      [2, PauseNoticeKind.Closed],
    ]);
  });

  it("a missing `notices` is read as [] (a pipeline's $concatArrays of a missing field would be null)", async () => {
    const store = storeOn();
    await store.findOrCreateByStepKey(pauseOf("p-bare"));
    const bare = {
      _id: mailboxIdOf("default", "p-bare", "listener:audit"),
      tenantId: "default",
      pauseId: "p-bare",
      recipient: "listener:audit",
    };
    await connectionTo(database.url())
      .db.collection<{ _id: string }>(Collections.PauseNotices)
      .insertOne(bare);

    await store.markSentByTenantIdAndPauseId("default", "p-bare", AUDIT);

    const box = await mailboxOf("p-bare", "listener:audit");
    expect(box).toMatchObject({ delivered: 0, attempts: 0, isDead: false });
    expect(box?.notices).toHaveLength(1);
    expect(box?.notices[0]).toMatchObject({ seq: 1, kind: PauseNoticeKind.Opened });
  });

  it("the head's time and every notice's time are BSON Dates, after the append and after an ack; null once all is delivered", async () => {
    const store = await sentPause("p-dates");
    await store.resolveByTenantIdAndPauseId("default", "p-dates", ANSWER, NINE, AUDIT);
    const boxes = mailboxesOf(connectionTo(database.url()).db);
    const typed = (type: "date") =>
      boxes.countDocuments({
        _id: mailboxIdOf("default", "p-dates", "listener:audit"),
        headWrittenAt: { $type: type },
        "notices.writtenAt": { $type: type },
      });
    expect(await typed("date")).toBe(1);

    const [first] = await store.claimNoticesDue(NINE, 5, seconds(60), ["listener:audit"]);
    const second = first === undefined ? undefined : await store.ackNotice(first, NINE);
    expect(second?.mailbox.headWrittenAt).toStrictEqual(NINE);
    expect(await typed("date")).toBe(1);
    expect(second === undefined ? undefined : await store.ackNotice(second, NINE)).toBeUndefined();

    expect(
      await boxes.findOne({ _id: mailboxIdOf("default", "p-dates", "listener:audit") }),
    ).toMatchObject({
      headWrittenAt: null,
      nextAttemptAt: null,
      delivered: 2,
    });
  });

  it("a mailbox whose head time is stored as a string is skipped by the stale look: the contract case bites", async () => {
    const store = await sentPause("p-string");
    const boxes = mailboxesOf(connectionTo(database.url()).db);
    const _id = mailboxIdOf("default", "p-string", "listener:audit");
    await boxes.updateOne({ _id }, [
      { $set: { headWrittenAt: { $dateToString: { date: "$headWrittenAt" } } } },
    ]);

    const skipped = await store.setAsideStaleNoticesBefore(
      new Date("2026-01-09T09:00:00.000Z"),
      NINE,
      "stale",
      10,
    );

    expect(skipped).toEqual([]);
    await boxes.updateOne({ _id }, [{ $set: { headWrittenAt: { $toDate: "$headWrittenAt" } } }]);
    const taken = await store.setAsideStaleNoticesBefore(
      new Date("2026-01-09T09:00:00.000Z"),
      NINE,
      "stale",
      10,
    );
    expect(taken.map((box) => box.pauseId)).toEqual(["p-string"]);
  });

  it("a text that starts with $ is stored as text, not read as a field path", async () => {
    const store = await sentPause("p-dollar");

    const wrote = await store.noticeOnceByTenantIdAndPauseId(
      "default",
      "p-dollar",
      PauseNoticeKind.JoinFailed,
      { launch: "$notices", errorCode: "$$ROOT" },
      NINE,
      AUDIT,
    );

    expect(wrote).toBe(true);
    const box = await mailboxOf("p-dollar", "listener:audit");
    expect(box?.notices[1]).toMatchObject({ launch: "$notices", errorCode: "$$ROOT" });
  });

  it("noticeOnce from five calls at once, three recipients: one writes, one joinFailed per recipient, no error", async () => {
    await sentPause("p-once", BOXES);
    const calls = [1, 2, 3, 4, 5].map(() =>
      storeOn().noticeOnceByTenantIdAndPauseId(
        "default",
        "p-once",
        PauseNoticeKind.JoinFailed,
        { launch: "run-1:join:1" },
        NINE,
        BOXES,
      ),
    );

    const results = await Promise.all(calls);

    expect(results.filter(Boolean)).toHaveLength(1);
    for (const recipient of ["channel:approvals", "listener:audit", "listener:ledger"]) {
      const box = await mailboxOf("p-once", recipient);
      const kinds = noticesOf(box).map((notice) => notice.kind);
      expect(kinds.filter((kind) => kind === "join-failed")).toHaveLength(1);
    }
  });

  it("the cursor never reuses a number: page one, delete the newest, insert, page two holds the new one", async () => {
    const store = storeOn();
    for (const id of ["c1", "c2", "c3"]) await store.findOrCreateByStepKey(pauseOf(id));
    const one = await store.findOpenAfter(undefined, 2);
    const pauses = connectionTo(database.url()).db.collection(Collections.Pauses);
    await pauses.deleteOne({ pauseId: "c3" });
    await store.findOrCreateByStepKey(pauseOf("c4"));

    const two = await store.findOpenAfter(one.next, 10);

    expect(one.pauses.map((pause) => pause.pauseId)).toEqual(["c1", "c2"]);
    expect(two.pauses.map((pause) => pause.pauseId)).toEqual(["c4"]);
    expect(two.next).toBeUndefined();
  });

  it("no recipients: a transition writes no mailbox", async () => {
    const store = storeOn();
    await store.findOrCreateByStepKey(pauseOf("p-nobody"));
    await store.markSentByTenantIdAndPauseId("default", "p-nobody", NO_RECIPIENTS);

    await store.resolveByTenantIdAndPauseId("default", "p-nobody", ANSWER, NINE, NO_RECIPIENTS);

    expect(
      await mailboxesOf(connectionTo(database.url()).db).countDocuments({ pauseId: "p-nobody" }),
    ).toBe(0);
  });
});
