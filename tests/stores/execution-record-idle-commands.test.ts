/**
 * The memory sweep's commands (agbossjs/agboss#1303c) as the client sends them, on a recording fake
 * (no server): the look for idle threads, the thread's runs, the write that locks its document, the
 * checks that keep it, the removal of its rows in every collection — each command whole, in order.
 */
import { Collections } from "../../src/index.js";
import { describe, expect, it } from "vitest";
import { deleteIdleThreads, type IsRunEnded } from "../../src/stores/records/record-idle.js";
import { idOf } from "../../src/stores/keys.js";

const CUTOFF = new Date("2026-01-05T09:00:00.000Z");
const SESSION = { id: "session" };
const THREAD = { tenantId: "default", threadId: "thread-1" };

interface Setup {
  /** Runs the thread's records name (`distinct("runId")`). */
  readonly runs?: readonly unknown[];
  /** What the lock's update matches (`0`: the thread came back to life). */
  readonly matched?: number;
  /** The counts of the live and of the other-run check, in the order they are asked. */
  readonly counts?: readonly number[];
  /** What the owner tombstone's update matches. */
  readonly tombstoned?: number;
}

/** A connection on a fake database that logs every command as `[collection, method, ...args]`. */
function recording(setup: Setup = {}) {
  const log: unknown[][] = [];
  const counts = [...(setup.counts ?? [0, 0])];
  const collection = (name: string) => ({
    find: (...args: unknown[]) => {
      log.push([name, "find", ...args]);
      const cursor = {
        sort: (sort: unknown) => {
          log.push([name, "sort", sort]);
          return cursor;
        },
        limit: (limit: unknown) => {
          log.push([name, "limit", limit]);
          return cursor;
        },
        toArray: () => Promise.resolve([{ _id: idOf("default", "thread-1"), ...THREAD }]),
      };
      return cursor;
    },
    distinct: (field: string, ...args: unknown[]) => {
      log.push([name, "distinct", field, ...args]);
      return Promise.resolve(field === "runId" ? (setup.runs ?? ["run-1"]) : ["record-1"]);
    },
    updateOne: (...args: unknown[]) => {
      log.push([name, "updateOne", ...args]);
      const isLock = JSON.stringify(args[1]).includes("sweepChecks");
      return Promise.resolve({
        matchedCount: isLock ? (setup.matched ?? 1) : (setup.tombstoned ?? 1),
      });
    },
    countDocuments: (...args: unknown[]) => {
      log.push([name, "countDocuments", ...args]);
      return Promise.resolve(counts.shift() ?? 0);
    },
    deleteMany: (...args: unknown[]) => {
      log.push([name, "deleteMany", ...args]);
      return Promise.resolve({});
    },
    deleteOne: (...args: unknown[]) => {
      log.push([name, "deleteOne", ...args]);
      return Promise.resolve({});
    },
  });
  const db = { collection };
  const connection = {
    db,
    inTransaction: (work: (transaction: unknown) => unknown) =>
      Promise.resolve(work({ db, session: SESSION })),
  } as never;
  return { connection, log };
}

const ended: IsRunEnded = () => Promise.resolve(true);
const sweep = (connection: never, isEnded = ended) =>
  deleteIdleThreads(connection, new Map([["desk-workflow", CUTOFF]]), isEnded);
const ID = idOf("default", "thread-1");

describe("the memory sweep's commands", () => {
  it("looks for the idle threads of the workflow oldest first, then removes an idle one whole, in order", async () => {
    const { connection, log } = recording();

    expect(await sweep(connection)).toBe(1);

    expect(log).toStrictEqual([
      [
        Collections.Threads,
        "find",
        { workflow: "desk-workflow", isSwept: false, lastActiveAt: { $lt: CUTOFF } },
        { projection: { tenantId: 1, threadId: 1 } },
      ],
      [Collections.Threads, "sort", { lastActiveAt: 1 }],
      [Collections.Threads, "limit", 100],
      [Collections.ExecutionRecords, "distinct", "runId", THREAD],
      [
        Collections.Threads,
        "updateOne",
        { _id: ID, workflow: "desk-workflow", isSwept: false, lastActiveAt: { $lt: CUTOFF } },
        { $inc: { sweepChecks: 1 } },
        { session: SESSION },
      ],
      [
        Collections.ExecutionRecords,
        "countDocuments",
        { ...THREAD, status: { $in: ["running", "paused", "queued"] } },
        { session: SESSION, limit: 1 },
      ],
      [
        Collections.ExecutionRecords,
        "countDocuments",
        { ...THREAD, runId: { $nin: [null, "run-1"] } },
        { session: SESSION, limit: 1 },
      ],
      [Collections.ExecutionRecords, "distinct", "_id", THREAD, { session: SESSION }],
      [Collections.ThreadStatusTransitions, "deleteMany", THREAD, { session: SESSION }],
      [
        Collections.ExecutionScores,
        "deleteMany",
        { recordId: { $in: ["record-1"] } },
        { session: SESSION },
      ],
      [
        Collections.PauseAnswers,
        "deleteMany",
        { tenantId: "default", rootExecutionId: { $in: ["run-1"] } },
        { session: SESSION },
      ],
      [Collections.ExecutionSummaries, "deleteMany", THREAD, { session: SESSION }],
      [Collections.ExecutionRecords, "deleteMany", THREAD, { session: SESSION }],
      [
        Collections.Threads,
        "updateOne",
        { _id: ID, owner: { $ne: null } },
        { $set: { isSwept: true } },
        { session: SESSION },
      ],
    ]);
  });

  it("a thread with no owner goes whole: its document is deleted, an owned one stays as a tombstone", async () => {
    const unowned = recording({ tombstoned: 0 });

    await sweep(unowned.connection);

    expect(unowned.log.at(-1)).toStrictEqual([
      Collections.Threads,
      "deleteOne",
      { _id: ID },
      { session: SESSION },
    ]);
    const owned = recording({ tombstoned: 1 });

    await sweep(owned.connection);

    expect(owned.log.map((one) => one[1])).not.toContain("deleteOne");
  });

  it("the runs are the text ones only: a record with no run id is no run to ask about", async () => {
    const { connection, log } = recording({ runs: ["run-1", null, 7] });
    const asked: string[] = [];

    await sweep(connection, (tree) => {
      asked.push(tree.rootExecutionId);
      return Promise.resolve(true);
    });

    expect(asked).toStrictEqual(["run-1"]);
    expect(JSON.stringify(log)).toContain('"runId":{"$nin":[null,"run-1"]}');
  });

  it("a thread that came back to life (the lock matches nothing) is kept and not counted, nothing else sent", async () => {
    const { connection, log } = recording({ matched: 0 });

    expect(await sweep(connection)).toBe(0);

    expect(log.map((one) => one[1])).not.toContain("countDocuments");
    expect(log.map((one) => one[1])).not.toContain("deleteMany");
  });

  it("a thread with a live record is kept", async () => {
    const { connection, log } = recording({ counts: [1, 0] });

    expect(await sweep(connection)).toBe(0);

    expect(log.map((one) => one[1])).not.toContain("deleteMany");
  });

  it("a thread with a run beyond the ones asked about is kept", async () => {
    const { connection, log } = recording({ counts: [0, 1] });

    expect(await sweep(connection)).toBe(0);

    expect(log.map((one) => one[1])).not.toContain("deleteMany");
  });

  it("a thread whose run has not ended is not even locked", async () => {
    const { connection, log } = recording();

    expect(await sweep(connection, () => Promise.resolve(false))).toBe(0);

    expect(log.map((one) => one[1])).not.toContain("updateOne");
  });
});
