/**
 * agbossjs/agboss#1307 (P6b, G3): a pause's times are `Date`s in memory. What the store does with them
 * without a server: a BSON Date in every field a query reads, canonical ISO text in the JSON a record
 * keeps, an Invalid Date refused before anything is written, a compare-and-set by instant (a re-read
 * record's fresh `Date`s still win), the keyset and the filters with the `Date` as it is.
 */
import { PauseStatus, type PauseRecord } from "@agboss/core";
import {
  NO_RECIPIENTS,
  PauseNoticeKind,
  seenOf,
  StoreError,
  type PauseNoticeClaim,
} from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";
import { MongoPausedExecutionRepository } from "../../src/index.js";
import { appendStage, mailboxOf } from "../../src/stores/paused/pause-mailboxes.js";
import {
  acknowledge,
  claimDue,
  renew,
  retry,
  setAsideStale,
} from "../../src/stores/paused/pause-delivery.js";
import {
  fieldsOf,
  findOrCreatePause,
  insertPause,
  listingFieldsOf,
  pauseIdOf,
  pauseOfDocument,
  writtenFieldsOf,
} from "../../src/stores/paused/pause-documents.js";
import {
  assertPauseFilter,
  dueBy,
  reassignedUnsentBefore,
} from "../../src/stores/paused/pause-scans.js";
import { NINE, pauseOf } from "../support/pauses.js";
import { pausedRunOf } from "../support/paused-run.js";

const BAD = new Date(Number.NaN);
const TEN = new Date("2026-01-05T10:00:00.000Z");
const NOON = new Date("2026-01-05T12:00:00.000Z");

/** The document a store keeps of `pause`, as `insertPause` makes it. */
const documentOf = (pause: PauseRecord): Record<string, unknown> => ({
  _id: pauseIdOf(pause.tenantId, pause.pauseId),
  tenantId: pause.tenantId,
  pauseId: pause.pauseId,
  rootExecutionId: pause.rootExecutionId,
  stepKey: pause.stepKey,
  seq: 1,
  target: pause.target,
  record: JSON.stringify(pause),
  ...fieldsOf(pause),
  ...listingFieldsOf(pause),
});

/** The refusal of an Invalid Date: the typed error naming the field (and its record), never a value. */
const refusing = (field: string, record = "pause", isInvalidDate = true): Error =>
  new StoreError.UnreadableRecord({
    record,
    fields: field,
    ...(isInvalidDate ? { isInvalidDate } : {}),
  });

/** The error `read` throws: a typed refusal that names `field` and shows no value. */
function unreadable(read: () => unknown, field: string): void {
  const error = (() => {
    try {
      read();
    } catch (thrown) {
      return thrown;
    }
    return undefined;
  })();
  expect(error).toBeInstanceOf(StoreError.UnreadableRecord);
  const { message } = error as Error;
  expect(message).toContain(field);
  expect(message).not.toContain("2026-01-05");
}

/** A database that fails the test on any use: a refused write reaches no collection. */
const UNTOUCHED = {
  collection: () => {
    throw new Error("the database was used");
  },
} as never;

describe("a pause's document: Dates in the fields a query reads, canonical text in the JSON", () => {
  it("makes BSON Dates (null when absent) of the deadline, the reminder and the close", () => {
    expect(fieldsOf(pauseOf("p"))).toMatchObject({
      expiresAt: null,
      remindAt: null,
      resolvedAt: null,
    });
    const fields = fieldsOf({ ...pauseOf("p"), expiresAt: TEN, remindAt: NINE, resolvedAt: NOON });
    expect(fields).toMatchObject({ expiresAt: TEN, remindAt: NINE, resolvedAt: NOON });
    expect(fields.expiresAt).toBeInstanceOf(Date);
  });

  it.each([
    ["askedAt", { askedAt: BAD }],
    ["firstAskedAt", { firstAskedAt: BAD }],
    ["maxExpiresAt", { maxExpiresAt: BAD }],
    ["resolvedAt", { resolvedAt: BAD }],
    ["expiresAt", { expiresAt: BAD }],
    ["remindAt", { remindAt: BAD }],
    ["boundAt", { boundAt: BAD }],
    ["closedFirst.resolvedAt", { closedFirst: { resolution: "replied", resolvedAt: BAD } }],
  ])("an Invalid Date in %s is refused by its name when the fields are made", (field, change) => {
    expect(() => fieldsOf({ ...pauseOf("p"), ...change } as PauseRecord)).toThrowError(
      refusing(field),
    );
  });

  it("an Invalid Date in the chain of custody is refused by its path", () => {
    const { trail } = pauseOf("p");
    expect(() =>
      fieldsOf({ ...pauseOf("p"), trail: trail.map((entry) => ({ ...entry, expiresAt: BAD })) }),
    ).toThrowError(refusing("trail[0].expiresAt"));
    expect(() =>
      fieldsOf({ ...pauseOf("p"), trail: trail.map((entry) => ({ ...entry, at: BAD })) }),
    ).toThrowError(refusing("trail[0].at"));
  });

  it("a pause with an Invalid Date is refused before a sequence is drawn or a document written", async () => {
    const bad = { ...pauseOf("p"), expiresAt: BAD };
    await expect(findOrCreatePause(UNTOUCHED, bad)).rejects.toThrowError(refusing("expiresAt"));
    await expect(insertPause(UNTOUCHED, undefined as never, bad)).rejects.toThrowError(
      refusing("expiresAt"),
    );
  });

  it("reads the record's Dates from its canonical text and the fields' Dates over it", () => {
    const pause = { ...pauseOf("p"), expiresAt: TEN, remindAt: NINE };
    const document = { ...documentOf(pause), expiresAt: NOON, remindAt: null };

    const read = pauseOfDocument(document);

    expect(read.askedAt).toStrictEqual(NINE);
    expect(read.expiresAt).toStrictEqual(NOON);
    expect(Object.keys(read)).not.toContain("remindAt");
  });

  it("reads every read into Dates of its own: a delivered Date moved leaves the next read alone", () => {
    const document = documentOf({ ...pauseOf("p"), expiresAt: TEN });

    const first = pauseOfDocument(document);
    first.expiresAt?.setTime(0);
    first.askedAt.setTime(0);

    const second = pauseOfDocument(document);
    expect(second.expiresAt).toStrictEqual(TEN);
    expect(second.askedAt).toStrictEqual(NINE);
  });

  it.each(["resolvedAt", "askedAt"])(
    "a text in the Date field %s of a document is refused by the field, never by the value",
    (field) => {
      const document = { ...documentOf(pauseOf("p")), [field]: "2026-01-05T09:00:00.000Z" };

      unreadable(() => pauseOfDocument(document), field);
    },
  );

  it("a text where a BSON Date belongs is refused by the field, never by the value", () => {
    const document = {
      ...documentOf({ ...pauseOf("p"), expiresAt: TEN }),
      expiresAt: "2026-01-05T10:00:00.000Z",
    };

    unreadable(() => pauseOfDocument(document), "expiresAt");
    expect(() => pauseOfDocument(document)).not.toThrowError(/2026-01-05/);
  });

  it.each([
    ["no zone", "2026-01-05T09:00:00.000"],
    ["an offset", "2026-01-05T11:00:00.000+02:00"],
    ["no milliseconds", "2026-01-05T09:00:00Z"],
    ["junk", "soon"],
  ])(
    "a record whose askedAt is written with %s is unreadable, never read in the zone of the process",
    (_how, text) => {
      const document = documentOf(pauseOf("p"));
      document.record = JSON.stringify({
        ...JSON.parse(String(document.record)),
        askedAt: text,
      });

      unreadable(() => pauseOfDocument(document), "askedAt");
    },
  );

  it("writes the record's times as canonical text and the closing's too", () => {
    const before = pauseOf("p");
    const after: PauseRecord = {
      ...before,
      status: PauseStatus.Taken,
      resolvedAt: TEN,
      expiresAt: NOON,
      trail: [...before.trail, { action: "reassigned", at: TEN, target: "t", expiresAt: NOON }],
    };

    const written = writtenFieldsOf(before, after);

    expect(written.$set).toMatchObject({ resolvedAt: TEN, expiresAt: NOON });
    const { record: recordText, closing } = written.$set as { record: string; closing: string };
    const record = JSON.parse(recordText);
    expect(record).toMatchObject({
      askedAt: "2026-01-05T09:00:00.000Z",
      expiresAt: "2026-01-05T12:00:00.000Z",
    });
    expect(record.trail[1]).toMatchObject({
      at: "2026-01-05T10:00:00.000Z",
      expiresAt: "2026-01-05T12:00:00.000Z",
    });
    expect(JSON.parse(closing)).toMatchObject({
      resolvedAt: "2026-01-05T10:00:00.000Z",
    });
  });

  it("a write of a pause with an Invalid Date makes no fields", () => {
    expect(() => writtenFieldsOf(pauseOf("p"), { ...pauseOf("p"), remindAt: BAD })).toThrowError(
      refusing("remindAt"),
    );
  });
});

describe("a mailbox: Dates where the store queries them, canonical text in the notice", () => {
  const stored = (notice: Record<string, unknown>) => ({
    tenantId: "default",
    pauseId: "p",
    recipient: "listener:audit",
    notices: [{ seq: 1, kind: PauseNoticeKind.Closed, writtenAt: NINE, ...notice }],
    delivered: 0,
    attempts: 0,
    nextAttemptAt: TEN,
    headWrittenAt: NINE,
    isDead: false,
  });

  it("reads Dates: the head, the next attempt, the notice's times", () => {
    const box = mailboxOf(
      stored({
        closedAt: "2026-01-05T09:30:00.000Z",
        expiresAt: "2026-01-05T11:00:00.000Z",
        previousExpiresAt: "2026-01-05T10:00:00.000Z",
      }),
    );

    expect(box.nextAttemptAt).toStrictEqual(TEN);
    expect(box.headWrittenAt).toStrictEqual(NINE);
    expect(box.notices[0]).toMatchObject({
      writtenAt: NINE,
      closedAt: new Date("2026-01-05T09:30:00.000Z"),
      expiresAt: new Date("2026-01-05T11:00:00.000Z"),
      previousExpiresAt: TEN,
    });
  });

  it("a text in claimedUntil makes the mailbox unreadable, naming the field", () => {
    const damaged = { ...stored({}), claimedUntil: "2026-01-05T09:00:00.000Z" };

    expect(() => mailboxOf(damaged)).toThrowError(/claimedUntil/);
    expect(mailboxOf({ ...stored({}), claimedUntil: null }).tenantId).toBe("default");
  });

  it("a delivered mailbox has no head", () => {
    expect(mailboxOf({ ...stored({}), headWrittenAt: null }).headWrittenAt).toBeUndefined();
  });

  it.each(["closedAt", "expiresAt", "previousExpiresAt"])(
    "a notice's %s in a spelling the framework did not write makes the mailbox unreadable, naming the field",
    (field) => {
      expect(() => mailboxOf(stored({ [field]: "2026-01-05T11:00:00+02:00" }))).toThrowError(
        refusing(field, "pause", false),
      );
    },
  );

  it("appends the notice with its times as text, its writtenAt and the head's Dates", () => {
    const planned = {
      recipient: "listener:audit",
      at: TEN,
      notice: {
        kind: PauseNoticeKind.Closed,
        writtenAt: NINE,
        closedAt: NOON,
        expiresAt: TEN,
        previousExpiresAt: NINE,
      },
    };

    const stage = appendStage({ tenantId: "default", pauseId: "p" }, planned);

    const notices = (stage as { $set: { notices: { $concatArrays: unknown[][] } } }).$set.notices
      .$concatArrays[1];
    expect(notices).toStrictEqual([
      {
        kind: { $literal: "closed" },
        writtenAt: NINE,
        closedAt: { $literal: "2026-01-05T12:00:00.000Z" },
        expiresAt: { $literal: "2026-01-05T10:00:00.000Z" },
        previousExpiresAt: { $literal: "2026-01-05T09:00:00.000Z" },
        seq: expect.anything(),
      },
    ]);
    const { $set } = stage as { $set: Record<string, { $cond: unknown[] }> };
    expect($set.headWrittenAt?.$cond[1]).toBe(NINE);
    expect($set.nextAttemptAt?.$cond[1]).toBe(TEN);
  });
});

describe("the scans: the keyset and the cut-offs are Dates as they are", () => {
  /** A database whose pauses `find` records its filter and answers none. */
  const finding = (): { db: Db; filters: unknown[] } => {
    const filters: unknown[] = [];
    const cursor = { sort: () => cursor, limit: () => cursor, toArray: () => Promise.resolve([]) };
    const collection = {
      find: (filter: unknown) => {
        filters.push(filter);
        return cursor;
      },
    };
    return { db: { collection: () => collection } as never, filters };
  };

  it("the keyset names the time as the Date it is, in all three branches", async () => {
    const { db, filters } = finding();

    await dueBy(db, "expiresAt", NOON, 10, { at: TEN, tenantId: "t", pauseId: "p" });

    expect(filters[0]).toStrictEqual({
      status: PauseStatus.Pending,
      expiresAt: { $lte: NOON, $type: "date" },
      $or: [
        { expiresAt: { $gt: TEN } },
        { expiresAt: TEN, tenantId: { $gt: "t" } },
        { expiresAt: TEN, tenantId: "t", pauseId: { $gt: "p" } },
      ],
    });
  });

  it("the reassigned-unsent scan keys by askedAt the same way", async () => {
    const { db, filters } = finding();

    await reassignedUnsentBefore(db, NOON, 10, { at: TEN, tenantId: "t", pauseId: "p" });

    expect(filters[0]).toMatchObject({
      askedAt: { $lt: NOON },
      $or: [{ askedAt: { $gt: TEN } }, { askedAt: TEN, tenantId: { $gt: "t" } }, expect.anything()],
    });
  });

  it.each([
    [
      "the keyset's time",
      (db: Db) => dueBy(db, "expiresAt", NOON, 10, { at: BAD, tenantId: "t", pauseId: "p" }),
      "after.at",
    ],
    ["the cut-off of a deadline scan", (db: Db) => dueBy(db, "remindAt", BAD, 10), "at"],
    [
      "the cut-off of the reassigned scan",
      (db: Db) => reassignedUnsentBefore(db, BAD, 10),
      "cutoff",
    ],
  ])("an Invalid Date in %s is refused, no query made", async (_what, scan, field) => {
    await expect(scan(UNTOUCHED)).rejects.toThrowError(refusing(field));
  });

  it("a listing's deadline bound that is Invalid is refused", () => {
    expect(() => {
      assertPauseFilter({ statuses: [PauseStatus.Pending], expiresBefore: BAD });
    }).toThrowError(refusing("expiresBefore"));
  });
});

describe("the notices' delivery: an Invalid Date is refused before the mailbox is touched", () => {
  const claim: PauseNoticeClaim = {
    mailbox: {
      tenantId: "default",
      pauseId: "p",
      recipient: "listener:audit",
      notices: [],
      delivered: 0,
      attempts: 0,
      nextAttemptAt: NINE,
      isDead: false,
    },
    token: "token",
    until: TEN,
  };

  it.each([
    ["a claim at", () => claimDue(UNTOUCHED, BAD, 1, 1000, ["listener:audit"]), "at"],
    ["an acknowledgement at", () => acknowledge(UNTOUCHED, claim, BAD), "at"],
    ["a renewal at", () => renew(UNTOUCHED, claim, BAD, 1000), "at"],
    ["a retry due at", () => retry(UNTOUCHED, claim, BAD, "failed"), "nextAttemptAt"],
    ["a set-aside before", () => setAsideStale(UNTOUCHED, BAD, NINE, "stale", 1), "writtenBefore"],
    ["a set-aside at", () => setAsideStale(UNTOUCHED, NINE, BAD, "stale", 1), "at"],
  ])("%s", async (_what, call, field) => {
    await expect(call()).rejects.toThrowError(refusing(field, "pause notice"));
  });

  it("every claim of a call has an `until` of its own", async () => {
    const documents = [1, 2].map((n) => ({
      tenantId: "default",
      pauseId: `p${String(n)}`,
      recipient: "listener:audit",
      notices: [],
      delivered: 0,
      attempts: 0,
      nextAttemptAt: NINE,
      headWrittenAt: null,
      claimedUntil: null,
      isDead: false,
    }));
    const collection = { findOneAndUpdate: () => Promise.resolve(documents.shift() ?? null) };
    const db = { collection: () => collection } as never;

    const [first, second] = await claimDue(db, TEN, 2, 1000, ["listener:audit"]);

    expect(first?.until).toStrictEqual(second?.until);
    expect(first?.until).not.toBe(second?.until);
  });

  it("the acknowledged claim's `until` is a copy of the caller's", async () => {
    const after = {
      tenantId: "default",
      pauseId: "p",
      recipient: "listener:audit",
      notices: [{ seq: 1, kind: PauseNoticeKind.Opened, writtenAt: NINE }],
      delivered: 1,
      attempts: 0,
      nextAttemptAt: TEN,
      headWrittenAt: NINE,
      isDead: false,
      claimedUntil: NOON,
    };
    const collection = { findOneAndUpdate: () => Promise.resolve(after) };
    const db = { collection: () => collection } as never;

    const next = await acknowledge(db, claim, NINE);

    expect(next?.until).toStrictEqual(TEN);
    expect(next?.until).not.toBe(claim.until);
  });
});

/**
 * A store on a fake database: the pauses collection answers a copy of the stored document (fresh
 * `Date`s on every read, as a driver hands out), `updateOne` is logged, the mailboxes take appends.
 */
function storeOn(pause: PauseRecord): {
  store: MongoPausedExecutionRepository;
  writes: { filter: unknown; update: unknown }[];
  appended: unknown[];
} {
  const document = documentOf(pause);
  const writes: { filter: unknown; update: unknown }[] = [];
  const appended: unknown[] = [];
  const pauses = {
    findOne: () => Promise.resolve(structuredClone(document)),
    updateOne: (filter: unknown, update: unknown) => {
      writes.push({ filter, update });
      return Promise.resolve({ matchedCount: 1 });
    },
    find: () => ({ project: () => ({ toArray: () => Promise.resolve([document]) }) }),
  };
  const mailboxes = {
    updateOne: (...args: unknown[]) => {
      appended.push(args);
      return Promise.resolve({});
    },
  };
  const db = {
    collection: (name: string) => (name.includes("notice") ? mailboxes : pauses),
  } as never;
  const connection = {
    db,
    inTransaction: (work: (transaction: unknown) => unknown) =>
      Promise.resolve(work({ db, session: undefined })),
  } as never;
  return {
    store: new MongoPausedExecutionRepository(connection, new VirtualClock()),
    writes,
    appended,
  };
}

describe("a transition of a pause: the core's rule over the record read, the Dates as they are", () => {
  const open = { ...pauseOf("p"), expiresAt: NOON };

  it("an answer is recorded with the close time as a BSON Date and the deadline in the filter as a Date", async () => {
    const { store, writes } = storeOn(open);

    const resolved = await store.resolveByTenantIdAndPauseId(
      "default",
      "p",
      { decision: { approved: true }, actor: undefined },
      TEN,
      NO_RECIPIENTS,
    );

    expect(resolved).toMatchObject({ status: PauseStatus.Resolved, resolvedAt: TEN });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.filter).toMatchObject({
      status: PauseStatus.Pending,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: TEN } }],
    });
    expect(writes[0]?.update).toMatchObject({ $set: { resolvedAt: TEN } });
  });

  it("an answer at the deadline is the expiry's: the core's rule refuses it, nothing is written", async () => {
    const { store, writes } = storeOn(open);

    const resolved = await store.resolveByTenantIdAndPauseId(
      "default",
      "p",
      { decision: 1, actor: undefined },
      NOON,
      NO_RECIPIENTS,
    );

    expect(resolved).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it("a `seen` read earlier wins over a record re-read into fresh Dates (compare by instant)", async () => {
    const { store, writes } = storeOn(open);
    const seen = seenOf(pauseOfDocument(documentOf(open)));

    const decided = await store.decideByTenantIdAndPauseId(
      "default",
      "p",
      { decision: 1, actor: undefined },
      TEN,
      seen,
    );

    expect(decided).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it("a `seen` of another deadline by one millisecond loses", async () => {
    const { store, writes } = storeOn(open);
    const seen = { ...seenOf(open), expiresAt: new Date(NOON.getTime() + 1) };

    const decided = await store.decideByTenantIdAndPauseId(
      "default",
      "p",
      { decision: 1, actor: undefined },
      TEN,
      seen,
    );

    expect(decided).toBe(false);
    expect(writes).toEqual([]);
  });

  it("a deadline change whose `previousExpiresAt` is a fresh Date of the same millisecond wins, and filters on that Date", async () => {
    const { store, writes, appended } = storeOn(open);
    const previousExpiresAt = new Date(NOON.getTime());
    const expiresAt = new Date(NOON.getTime() + 3_600_000);

    const changed = await store.changeTimeoutByTenantIdAndPauseId(
      "default",
      "p",
      { expiresAt, previousExpiresAt, seen: seenOf(open) },
      TEN,
      { listeners: ["audit"] },
    );

    expect(changed?.expiresAt).toStrictEqual(expiresAt);
    expect(writes[0]?.filter).toMatchObject({
      $and: [{ expiresAt: { $eq: previousExpiresAt } }, { expiresAt: { $gt: TEN } }],
    });
    expect(writes[0]?.update).toMatchObject({ $set: { expiresAt } });
    const record = JSON.parse((writes[0]?.update as { $set: { record: string } }).$set.record);
    expect(record.expiresAt).toBe("2026-01-05T13:00:00.000Z");
    expect(appended).toHaveLength(1);
  });

  it("a deadline change from a deadline one millisecond off loses", async () => {
    const { store, writes } = storeOn(open);

    const changed = await store.changeTimeoutByTenantIdAndPauseId(
      "default",
      "p",
      {
        expiresAt: new Date(NOON.getTime() + 1000),
        previousExpiresAt: new Date(NOON.getTime() - 1),
        seen: seenOf(open),
      },
      TEN,
      NO_RECIPIENTS,
    );

    expect(changed).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it("an in-place reassignment, planned against a `seen` of the pause, applies over a re-read record", async () => {
    const { store, writes } = storeOn(open);

    const moved = await store.reassignByTenantIdAndPauseId(
      "default",
      "p",
      { seen: seenOf(open), assignees: ["alice"] },
      TEN,
      NO_RECIPIENTS,
    );

    expect(moved).toMatchObject({ assignees: ["alice"], expiresAt: NOON });
    expect(writes[0]?.update).toMatchObject({ $set: { assignees: ["alice"] } });
  });

  it.each([
    [
      "an answer",
      (store: MongoPausedExecutionRepository) =>
        store.resolveByTenantIdAndPauseId(
          "default",
          "p",
          { decision: 1, actor: undefined },
          BAD,
          NO_RECIPIENTS,
        ),
    ],
    [
      "a decision",
      (store: MongoPausedExecutionRepository) =>
        store.decideByTenantIdAndPauseId(
          "default",
          "p",
          { decision: 1, actor: undefined },
          BAD,
          seenOf(open),
        ),
    ],
    [
      "a cancel",
      (store: MongoPausedExecutionRepository) =>
        store.cancelByTenantIdAndPauseId("default", "p", "withdrawn" as never, BAD, NO_RECIPIENTS),
    ],
    [
      "an expiry",
      (store: MongoPausedExecutionRepository) =>
        store.expireByTenantIdAndPauseId("default", "p", {}, BAD, NO_RECIPIENTS),
    ],
    [
      "the close of an untaken answer",
      (store: MongoPausedExecutionRepository) =>
        store.closeUntakenByTenantIdAndPauseId(
          "default",
          "p",
          "cancelled" as never,
          BAD,
          NO_RECIPIENTS,
        ),
    ],
    [
      "a reminder",
      (store: MongoPausedExecutionRepository) =>
        store.remindByTenantIdAndPauseId("default", "p", BAD, NO_RECIPIENTS),
    ],
    [
      "a reassignment",
      (store: MongoPausedExecutionRepository) =>
        store.reassignByTenantIdAndPauseId(
          "default",
          "p",
          { seen: seenOf(open) },
          BAD,
          NO_RECIPIENTS,
        ),
    ],
    [
      "a reassignment's deadline",
      (store: MongoPausedExecutionRepository) =>
        store.reassignByTenantIdAndPauseId(
          "default",
          "p",
          { seen: seenOf(open), due: { expiresAt: BAD } },
          NOON,
          NO_RECIPIENTS,
        ),
    ],
    [
      "a deadline change at",
      (store: MongoPausedExecutionRepository) =>
        store.changeTimeoutByTenantIdAndPauseId(
          "default",
          "p",
          { expiresAt: NOON, previousExpiresAt: NOON, seen: seenOf(open) },
          BAD,
          NO_RECIPIENTS,
        ),
    ],
    [
      "a deadline change to",
      (store: MongoPausedExecutionRepository) =>
        store.changeTimeoutByTenantIdAndPauseId(
          "default",
          "p",
          { expiresAt: BAD, previousExpiresAt: NOON, seen: seenOf(open) },
          TEN,
          NO_RECIPIENTS,
        ),
    ],
    [
      "a once-notice at",
      (store: MongoPausedExecutionRepository) =>
        store.noticeOnceByTenantIdAndPauseId(
          "default",
          "p",
          PauseNoticeKind.Expiring,
          {},
          BAD,
          NO_RECIPIENTS,
        ),
    ],
    [
      "a once-notice's fact",
      (store: MongoPausedExecutionRepository) =>
        store.noticeOnceByTenantIdAndPauseId(
          "default",
          "p",
          PauseNoticeKind.TimeoutChanged,
          { expiresAt: BAD },
          NINE,
          NO_RECIPIENTS,
        ),
    ],
  ])(
    "%s with an Invalid Date is a StoreError.UnreadableRecord and writes nothing",
    async (_what, call) => {
      const { store, writes, appended } = storeOn(open);

      const refused = await call(store).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(refused).toBeInstanceOf(StoreError.UnreadableRecord);
      expect(writes).toEqual([]);
      expect(appended).toEqual([]);
    },
  );

  it("the record a transition returns holds copies: moving a Date of it moves nothing the caller passed", async () => {
    const { store } = storeOn(open);
    const at = new Date(TEN.getTime());

    const resolved = await store.resolveByTenantIdAndPauseId(
      "default",
      "p",
      { decision: 1, actor: undefined },
      at,
      NO_RECIPIENTS,
    );

    expect(resolved?.resolvedAt).not.toBe(at);
    resolved?.resolvedAt?.setTime(0);
    resolved?.trail.forEach((entry) => entry.at.setTime(0));
    expect(at).toStrictEqual(TEN);
  });

  it("a reassignment returns a copy of the pause it made, not the caller's Dates", async () => {
    const { store } = storeOn(open);
    const due = new Date(NOON.getTime());
    const moved = await store.reassignByTenantIdAndPauseId(
      "default",
      "p",
      { seen: seenOf(open), assignees: ["alice"], timeout: { expiresAt: due } },
      TEN,
      NO_RECIPIENTS,
    );

    expect(moved?.expiresAt).not.toBe(due);
    moved?.expiresAt?.setTime(0);
    expect(due).toStrictEqual(NOON);
  });

  it("a deadline taken away comes back with no `expiresAt` key at all, as a read gives it", async () => {
    const { store } = storeOn(open);

    const changed = await store.changeTimeoutByTenantIdAndPauseId(
      "default",
      "p",
      { previousExpiresAt: NOON, seen: seenOf(open) },
      TEN,
      NO_RECIPIENTS,
    );

    expect(changed).not.toBeUndefined();
    expect(Object.keys(changed ?? {})).not.toContain("expiresAt");
    expect(Object.keys(changed ?? {})).not.toContain("remindAt");
  });

  it("a set-aside at an Invalid Date is refused through the store, nothing written", async () => {
    const { store, writes } = storeOn(open);
    const claim = {
      mailbox: {
        tenantId: "default",
        pauseId: "p",
        recipient: "listener:audit",
        notices: [],
        delivered: 0,
        attempts: 0,
        nextAttemptAt: NINE,
        isDead: false,
      },
      token: "t",
      until: TEN,
    };

    await expect(store.setAsideNotices(claim, BAD, "gave up")).rejects.toThrowError(
      refusing("at", "pause notice"),
    );
    expect(writes).toEqual([]);
  });

  it.each(["expiresAt", "remindAt", "previousExpiresAt"])(
    "a deadline change with an Invalid %s is refused before the read, even for a pause that does not exist",
    async (field) => {
      const { store, writes } = storeOn(open);
      const change = { seen: seenOf(open), [field]: BAD };

      await expect(
        store.changeTimeoutByTenantIdAndPauseId("default", "missing", change, TEN, NO_RECIPIENTS),
      ).rejects.toThrowError(refusing(field));
      expect(writes).toEqual([]);
    },
  );

  it("a paused run with an Invalid Date in a pending deadline is refused before it is saved", async () => {
    const { store } = storeOn(open);
    const pending = { expiresAt: BAD } as never;

    await expect(
      store.save({
        run: { ...pausedRunOf(), pending: [pending] },
        workflowVersion: "v1",
        configHash: "h",
      }),
    ).rejects.toThrowError(refusing("pending[0].expiresAt", "paused run"));
  });
});
