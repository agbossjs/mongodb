/**
 * agbossjs/agboss#1213: what the pause documents say and refuse — the times a record holds, the
 * fields a document keeps over its record's, the texts that are no JSON (named by their ids), the
 * step that two instances make at once, a paused run's own reads and deletes.
 */
import { PauseStatus, type PauseRecord } from "@agboss/core";
import { StoredNamesUnreadableError, PauseNoticeKind } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { MongoServerError, type Db } from "mongodb";
import { beforeEach, describe, expect, it } from "vitest";
import { fillPauseChannels } from "../../src/connection/pause-channels.js";
import { Collections, MongoConnection, MongoPausedExecutionRepository } from "../../src/index.js";
import { idOf } from "../../src/stores/keys.js";
import {
  dateOf,
  dateOrNull,
  fieldsOf,
  findOrCreatePause,
  insertPause,
} from "../../src/stores/paused/pause-documents.js";
import { mailboxesOf } from "../../src/stores/paused/pause-mailboxes.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { NINE, pauseOf } from "../support/pauses.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();

beforeEach(() => emptyAll(database.url()));

const storeOn = () =>
  new MongoPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());
const dbOf = (): Db => connectionTo(database.url()).db;
const pauses = () => dbOf().collection(Collections.Pauses);
interface PausedRow {
  _id: string;
  runId: string;
  run: string;
  workflowVersion: string;
  configHash: string;
}
const badTime = (field: string) =>
  new TypeError(`a pause's ${field} is an ISO 8601 time, not "soon"`);

describe("agbossjs/agboss#1213: the times a record holds", () => {
  it("a text that is no time is refused by the field and the text", () => {
    expect(() => dateOf("soon", "askedAt")).toThrowError(badTime("askedAt"));
    expect(dateOrNull(undefined, "expiresAt")).toBeNull();
    expect(dateOrNull("2026-01-05T09:00:00.000Z", "expiresAt")).toStrictEqual(NINE);
  });

  it.each(["resolvedAt", "expiresAt", "remindAt"] as const)(
    "a %s that is no time is refused by its name when the fields are made",
    (field) => {
      expect(() => fieldsOf({ ...pauseOf("p"), [field]: "soon" })).toThrowError(badTime(field));
    },
  );

  it("a replacement with an asked time that is no time is refused before it is inserted; a pause with no origin has no asked-at column", async () => {
    const connection = connectionTo(database.url());
    const session = connection.client.startSession();
    try {
      await expect(
        insertPause(connection.db, session, {
          ...pauseOf("r"),
          reassignedFrom: "p",
          askedAt: "soon",
        }),
      ).rejects.toThrowError(badTime("askedAt"));
      await insertPause(connection.db, session, pauseOf("plain"));
    } finally {
      await session.endSession();
    }

    const stored = await pauses().findOne({ pauseId: "plain" });
    expect(stored).not.toBeNull();
    expect(Object.keys(stored ?? {})).not.toContain("askedAt");
    expect(await pauses().countDocuments({ pauseId: "r" })).toBe(0);
  });
});

describe("agbossjs/agboss#1213: the fields a document keeps over its record's", () => {
  it("a document of schema version 1, with no deadline fields, reads the record's own", async () => {
    const deadline = "2026-01-06T09:00:00.000Z";
    await storeOn().findOrCreateByStepKey({
      ...pauseOf("p"),
      expiresAt: deadline,
      remindAt: deadline,
    });
    await pauses().updateOne(
      { pauseId: "p" },
      { $unset: { expiresAt: "", remindAt: "", expiryBound: "" } },
    );

    const read = await storeOn().findByTenantIdAndPauseId("default", "p");

    expect(read).toMatchObject({ expiresAt: deadline, remindAt: deadline });
  });

  it("a pending pause has no closing text, stored or after an extension", async () => {
    const store = storeOn();
    await store.findOrCreateByStepKey({ ...pauseOf("p"), expiresAt: "2026-01-06T09:00:00.000Z" });
    expect((await pauses().findOne({ pauseId: "p" }))?.closing).toBeNull();

    await store.extendByTenantIdAndPauseId(
      "default",
      "p",
      {
        expiresAt: "2026-01-07T09:00:00.000Z",
        previousExpiresAt: "2026-01-06T09:00:00.000Z",
        remindAt: undefined,
      },
      NINE,
      { listeners: [] },
    );

    expect((await pauses().findOne({ pauseId: "p" }))?.closing).toBeNull();
  });
});

describe("agbossjs/agboss#1213: a text that is no JSON names its row by its ids", () => {
  const unreadable = (ids: string) =>
    `a stored pause is not readable (${ids}): the text is not valid JSON`;

  it.each(["record", "closing"] as const)("a pause's %s", async (field) => {
    await storeOn().findOrCreateByStepKey(pauseOf("p"));
    await pauses().updateOne(
      { pauseId: "p" },
      { $set: { status: PauseStatus.Cancelled, closing: "{}", record: "{}", [field]: "{nope" } },
    );

    await expect(storeOn().findByTenantIdAndPauseId("default", "p")).rejects.toThrowError(
      unreadable("pauseId p, rootExecutionId run-1"),
    );
  });

  it("a channel the migration fills from a record that is no JSON", async () => {
    await storeOn().findOrCreateByStepKey(pauseOf("p"));
    await pauses().updateOne(
      { pauseId: "p" },
      { $set: { record: "{nope" }, $unset: { channel: "" } },
    );

    const refused = fillPauseChannels(dbOf());

    await expect(refused).rejects.toBeInstanceOf(StoredNamesUnreadableError);
    await expect(refused).rejects.toThrowError(
      "a stored pause is not readable: the text is not valid JSON",
    );
  });

  it("a paused run, by its thread and run", async () => {
    await dbOf()
      .collection<PausedRow>(Collections.PausedExecutions)
      .insertOne({
        _id: idOf("default", "t1"),
        runId: "r1",
        run: "{nope",
        workflowVersion: "1",
        configHash: "h",
      });

    await expect(storeOn().findByTenantIdAndThreadId("default", "t1")).rejects.toThrowError(
      "a stored paused run is not readable (threadId t1, runId r1): the text is not valid JSON",
    );
  });
});

describe("agbossjs/agboss#1213: the pause of a step that two instances make at once", () => {
  /** `db` whose pauses' upsert fails with `error`. */
  function upsertFailing(db: Db, error: Error): Db {
    const failing = new Proxy(db.collection(Collections.Pauses), {
      get(target, property) {
        if (property === "updateOne") return () => Promise.reject(error);
        const member: unknown = Reflect.get(target, property);
        return typeof member === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(member, target, args)
          : member;
      },
    });
    return new Proxy(db, {
      get(target, property) {
        if (property === "collection")
          return (name: string) =>
            name === Collections.Pauses ? failing : target.collection(name);
        const member: unknown = Reflect.get(target, property);
        return typeof member === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(member, target, args)
          : member;
      },
    });
  }

  const duplicate = new MongoServerError({ message: "E11000 duplicate key", code: 11000 });

  it("the loser of a duplicate key reads the pause the winner made", async () => {
    await storeOn().findOrCreateByStepKey(pauseOf("winner"));
    const loser: PauseRecord = { ...pauseOf("loser"), stepKey: pauseOf("winner").stepKey };

    const made = await findOrCreatePause(upsertFailing(dbOf(), duplicate), loser);

    expect(made.pauseId).toBe("winner");
  });

  it("any other failure of the write is the caller's", async () => {
    const down = new MongoServerError({ message: "not primary", code: 10107 });

    await expect(findOrCreatePause(upsertFailing(dbOf(), down), pauseOf("p"))).rejects.toBe(down);
  });
});

describe("agbossjs/agboss#1213: the paused run and the pause's own reads", () => {
  it("deleting one thread's paused run leaves another's", async () => {
    const store = storeOn();
    const db = dbOf();
    for (const thread of ["t2", "t1"])
      await db.collection<PausedRow>(Collections.PausedExecutions).insertOne({
        _id: idOf("default", thread),
        runId: "r",
        run: "{}",
        workflowVersion: "1",
        configHash: "h",
      });

    await store.deleteByTenantIdAndThreadId("default", "t1");

    expect(await db.collection<PausedRow>(Collections.PausedExecutions).distinct("_id")).toEqual([
      idOf("default", "t2"),
    ]);
  });

  it("a notice with a fact that is not text writes no such field", async () => {
    const store = storeOn();
    await store.findOrCreateByStepKey(pauseOf("p"));
    await store.markSentByTenantIdAndPauseId("default", "p", { listeners: ["audit"] });

    await store.noticeOnceByTenantIdAndPauseId(
      "default",
      "p",
      PauseNoticeKind.Extended,
      { expiresAt: undefined, previousExpiresAt: "2026-01-05T09:00:00.000Z" },
      NINE,
      { listeners: ["audit"] },
    );

    const box = await mailboxesOf(dbOf()).findOne({ pauseId: "p" });
    expect(Object.keys(box?.notices[1] ?? {}).sort()).toEqual([
      "kind",
      "previousExpiresAt",
      "seq",
      "writtenAt",
    ]);
  });

  it("a store whose deployment does not answer has a ping that rejects", async () => {
    const connection = new MongoConnection({
      url: "mongodb://127.0.0.1:1/?replicaSet=rs0&serverSelectionTimeoutMS=200",
    });
    try {
      await expect(
        new MongoPausedExecutionRepository(connection, new VirtualClock()).ping(),
      ).rejects.toThrowError(/ECONNREFUSED|Server selection timed out/);
    } finally {
      await connection.onDestroy();
    }
  });
});
