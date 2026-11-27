/**
 * The execution record store's commands as the client sends them, on a recording fake (no server):
 * the finish that never lands over a stop or cancel mark, the restart of a swept thread, the append
 * with its thread's activity, the pause answers read back in the order asked.
 */
import { InterruptMode } from "@agboss/core";
import { StoreError } from "@agboss/core/stores";
import { describe, expect, it, vi } from "vitest";
import { Collections } from "../../src/index.js";
import { idOf } from "../../src/stores/keys.js";
import { completeUnlessInterrupted } from "../../src/stores/records/record-interrupt.js";
import { appendRecord, pauseAnswerTextsOf } from "../../src/stores/records/record-writes.js";
import { claimExisting } from "../../src/stores/records/record-threads.js";

const appended = vi.hoisted(() => vi.fn());

vi.mock("../../src/stores/status-log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/stores/status-log.js")>()),
  appendRecordStatus: appended,
}));

const SESSION = { id: "session" };
const NOW = new Date("2026-01-05T09:00:00.000Z");

interface Replies {
  readonly record?: object | null;
  readonly marks?: object;
  readonly finished?: object | null;
  readonly thread?: object | null;
  readonly restarted?: number;
  readonly touched?: number;
  /** What the pause answers' find answers. */
  readonly answers?: readonly object[];
}

/** A fake database logging `[collection, method, ...args]`; each method answers what `replies` says. */
function recording(replies: Replies = {}) {
  const log: unknown[][] = [];
  const collection = (name: string) => ({
    findOne: (...args: unknown[]) => {
      log.push([name, "findOne", ...args]);
      if (name === Collections.ExecutionRecords)
        return Promise.resolve(replies.record === undefined ? null : replies.record);
      if (name === Collections.Threads)
        return Promise.resolve(replies.thread === undefined ? null : replies.thread);
      return Promise.resolve(replies.marks ?? {});
    },
    findOneAndUpdate: (...args: unknown[]) => {
      log.push([name, "findOneAndUpdate", ...args]);
      if (name === Collections.Sequences) return Promise.resolve({ value: 7 });
      return Promise.resolve(replies.finished === undefined ? null : replies.finished);
    },
    updateOne: (...args: unknown[]) => {
      log.push([name, "updateOne", ...args]);
      const matchedCount =
        name === Collections.Threads && JSON.stringify(args[1]).includes("lastActiveAt")
          ? (replies.touched ?? replies.restarted ?? 1)
          : (replies.restarted ?? 1);
      return Promise.resolve({ matchedCount });
    },
    insertOne: (...args: unknown[]) => {
      log.push([name, "insertOne", ...args]);
      return Promise.resolve({});
    },
    find: () => {
      const cursor = {
        sort: () => cursor,
        toArray: () =>
          Promise.resolve(replies.answers ?? [{ record: "{}", askedAt: "not a date" }]),
      };
      return cursor;
    },
  });
  const db = { collection };
  const connection = {
    db,
    inTransaction: (work: (transaction: unknown) => unknown) =>
      Promise.resolve(work({ db, session: SESSION })),
  } as never;
  return { db: db as never, connection, log };
}

const OUTCOME = { status: "answered", route: [], steps: [], costUsd: 0 } as never;
const WRITE = { now: NOW, context: undefined, expected: undefined } as never;
const ID = "record-1";

describe("completeUnlessInterrupted", () => {
  it("reads the record's tree, writes the root's lease document and reads its marks, in the session", async () => {
    const { connection, log } = recording({ record: { tenantId: "default", runId: "run-1" } });

    await completeUnlessInterrupted(connection, ID, OUTCOME, WRITE);

    const tree = idOf("default", "run-1");
    expect(log.slice(0, 3)).toStrictEqual([
      [
        Collections.ExecutionRecords,
        "findOne",
        { _id: ID },
        { session: SESSION, projection: { tenantId: 1, runId: 1 } },
      ],
      [
        Collections.ExecutionLeases,
        "updateOne",
        { _id: tree },
        expect.arrayContaining([
          { $set: { fenceChecks: { $add: [{ $ifNull: ["$fenceChecks", 0] }, 1] } } },
        ]),
        { upsert: true, session: SESSION },
      ],
      [Collections.ExecutionLeases, "findOne", { _id: tree }, { session: SESSION }],
    ]);
  });

  it.each([
    ["a cancel mark", { cancelRequestedAt: NOW }],
    ["a stop mark", { stopMode: InterruptMode.Immediate }],
  ])("a tree with %s refuses the finish: false, the record not written", async (_what, marks) => {
    const { connection, log } = recording({
      record: { tenantId: "default", runId: "run-1" },
      marks,
    });

    expect(await completeUnlessInterrupted(connection, ID, OUTCOME, WRITE)).toBe(false);

    expect(log.map((one) => one[1])).not.toContain("findOneAndUpdate");
  });

  it("a tree with neither mark writes the record in the session, answering the document after", async () => {
    const { connection, log } = recording({ record: { tenantId: "default", runId: "run-1" } });

    await completeUnlessInterrupted(connection, ID, OUTCOME, WRITE);

    const written = log.find((one) => one[1] === "findOneAndUpdate");
    expect(written?.[0]).toBe(Collections.ExecutionRecords);
    expect(written?.[4]).toStrictEqual({
      session: SESSION,
      returnDocument: "after",
      projection: { tenantId: 1, threadId: 1 },
    });
  });

  it.each([
    ["no record", null],
    ["a record of no run", { tenantId: "default", runId: null }],
  ])("%s: no lease document is written or read, the finish is written", async (_what, record) => {
    const { connection, log } = recording({ record });

    await completeUnlessInterrupted(connection, ID, OUTCOME, WRITE);

    expect(log.map((one) => one[0])).not.toContain(Collections.ExecutionLeases);
    expect(log.map((one) => one[1])).toContain("findOneAndUpdate");
  });
});

describe("claimExisting: a swept thread restarted by its owner", () => {
  const claim = { tenantId: "default", threadId: "t-1", ownerId: "owner-1" };

  it("reads the thread's document, and leaves one that is not swept, or none, as it is", async () => {
    const live = recording({ thread: { isSwept: false, owner: "owner-1" } });
    const none = recording({ thread: null });

    await claimExisting(live.db, claim, NOW);
    await claimExisting(none.db, claim, NOW);

    expect(live.log).toStrictEqual([
      [Collections.Threads, "findOne", { _id: idOf("default", "t-1") }],
    ]);
    expect(none.log.map((one) => one[1])).toStrictEqual(["findOne"]);
  });

  it("restarts it for its owner in one conditional update", async () => {
    const { db, log } = recording({ thread: { isSwept: true, owner: "owner-1" } });

    await claimExisting(db, claim, NOW);

    expect(log[1]).toStrictEqual([
      Collections.Threads,
      "updateOne",
      { _id: idOf("default", "t-1"), isSwept: true, owner: "owner-1" },
      { $set: { isSwept: false, lastActiveAt: NOW } },
    ]);
  });

  it("an ownerless claim names no owner: the update matches a thread with none (null)", async () => {
    const { db, log } = recording({ thread: { isSwept: true, owner: null } });

    await claimExisting(db, { tenantId: "default", threadId: "t-1" }, NOW);

    expect(log[1]?.[2]).toStrictEqual({ _id: idOf("default", "t-1"), isSwept: true, owner: null });
  });

  it("another owner's, or an unowned one's, is refused; the owner's own that matched nothing is not", async () => {
    const other = recording({ thread: { isSwept: true, owner: "owner-2" }, restarted: 0 });
    await expect(claimExisting(other.db, claim, NOW)).rejects.toThrow(/belongs to another owner/);

    const same = recording({ thread: { isSwept: true, owner: "owner-1" }, restarted: 0 });
    await expect(claimExisting(same.db, claim, NOW)).resolves.toBeUndefined();

    const matched = recording({ thread: { isSwept: true, owner: "owner-2" }, restarted: 1 });
    await expect(claimExisting(matched.db, claim, NOW)).resolves.toBeUndefined();
  });
});

describe("appendRecord", () => {
  const record = { tenantId: "default", threadId: "t-1", status: "running" } as never;

  it("touches the thread's activity, inserts the record with its sequence and writes its status, all in the session", async () => {
    appended.mockClear();
    const { connection, log } = recording();

    const turn = await appendRecord(connection, record, { now: NOW });

    expect(log.slice(1)).toStrictEqual([
      [
        Collections.Threads,
        "updateOne",
        { _id: idOf("default", "t-1"), isSwept: false },
        { $set: { lastActiveAt: NOW } },
        { session: SESSION },
      ],
      [
        Collections.ExecutionRecords,
        "insertOne",
        expect.objectContaining({ _id: turn.id, seq: 7, createdAt: NOW }),
        { session: SESSION },
      ],
    ]);
    expect(appended).toHaveBeenCalledTimes(1);
  });

  it("a swept thread takes no record: refused, nothing inserted", async () => {
    const { connection, log } = recording({ touched: 0 });

    await expect(appendRecord(connection, record, { now: NOW })).rejects.toThrow(/was swept/);

    expect(log.map((one) => one[1])).not.toContain("insertOne");
  });
});

describe("pauseAnswerTextsOf", () => {
  it("refuses an entry whose askedAt is no BSON Date, naming the tree and the field, never the value", async () => {
    const { db } = recording();

    await expect(pauseAnswerTextsOf(db, "default", "root-1")).rejects.toThrowError(
      new StoreError.UnreadableRecord({
        record: "pause answer",
        ids: "tenantId default, rootExecutionId root-1",
        fields: "askedAt",
      }),
    );
  });

  it("names every field that failed, in the schema's order", async () => {
    const { db } = recording({ answers: [{ record: 5, askedAt: "not a date" }] });

    await expect(pauseAnswerTextsOf(db, "default", "root-1")).rejects.toThrowError(
      new StoreError.UnreadableRecord({
        record: "pause answer",
        ids: "tenantId default, rootExecutionId root-1",
        fields: "record, askedAt",
      }),
    );
  });

  it("answers the stored texts in the order the find gave them", async () => {
    const { db } = recording({
      answers: [
        { record: "a", askedAt: NOW },
        { record: "b", askedAt: NOW },
      ],
    });

    expect(await pauseAnswerTextsOf(db, "default", "root-1")).toStrictEqual(["a", "b"]);
  });
});
