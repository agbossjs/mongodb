/**
 * The thread status history's commands as the client sends them, on a recording fake (no server):
 * the document a change writes with only the details it has, the record write that is no change, the
 * history read oldest first, the removal of a thread's documents.
 */
import { StatusTrigger, ThreadStatus } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { Collections } from "../../src/index.js";
import { idOf } from "../../src/stores/keys.js";
import {
  appendRecordStatus,
  appendStatus,
  forgottenStatus,
  historyOf,
} from "../../src/stores/status-log.js";

const SESSION = { id: "session" } as never;
const NOW = new Date("2026-01-05T09:00:00.000Z");
const THREAD = { tenantId: "default", threadId: "t-1" };

/** A fake database whose transitions collection holds `last` as the thread's last change. */
function recording(last: object | null = null) {
  const log: unknown[][] = [];
  const collection = (name: string) => ({
    findOne: (...args: unknown[]) => {
      log.push([name, "findOne", ...args]);
      return Promise.resolve(last);
    },
    insertOne: (...args: unknown[]) => {
      log.push([name, "insertOne", ...args]);
      return Promise.resolve({});
    },
    deleteMany: (...args: unknown[]) => {
      log.push([name, "deleteMany", ...args]);
      return Promise.resolve({});
    },
    find: (...args: unknown[]) => {
      log.push([name, "find", ...args]);
      const cursor = {
        sort: (sort: unknown) => {
          log.push([name, "sort", sort]);
          return cursor;
        },
        toArray: () => Promise.resolve([]),
      };
      return cursor;
    },
  });
  return { db: { collection } as never, log };
}

const PAUSED = { ...THREAD, toStatus: ThreadStatus.Paused, trigger: StatusTrigger.Pause };

describe("appendStatus", () => {
  it("reads the last change in the session and writes the next one whole, with the details it has", async () => {
    const { db, log } = recording();

    const written = await appendStatus(
      db,
      SESSION,
      { ...PAUSED, reason: "why", actor: "a", leaseToken: 3 },
      NOW,
    );

    expect(log[0]).toStrictEqual([
      Collections.ThreadStatusTransitions,
      "findOne",
      THREAD,
      { session: SESSION, sort: { seq: -1 } },
    ]);
    expect(log[1]).toStrictEqual([
      Collections.ThreadStatusTransitions,
      "insertOne",
      {
        _id: idOf("default", "t-1", 1),
        ...THREAD,
        seq: 1,
        fromStatus: null,
        toStatus: ThreadStatus.Paused,
        trigger: StatusTrigger.Pause,
        reason: "why",
        actor: "a",
        leaseToken: 3,
        at: NOW,
      },
      { session: SESSION },
    ]);
    expect(written).toMatchObject({ seq: 1 });
  });

  it("writes no detail it was not given", async () => {
    const { db, log } = recording();

    await appendStatus(db, SESSION, PAUSED, NOW);

    const document = log[1]?.[2] as object;
    expect(Object.keys(document)).not.toContain("reason");
    expect(Object.keys(document)).not.toContain("actor");
    expect(Object.keys(document)).not.toContain("leaseToken");
  });

  it("a repeat of the last status changes nothing: nothing is written", async () => {
    const last = {
      ...THREAD,
      seq: 1,
      fromStatus: null,
      toStatus: "paused",
      trigger: "pause",
      at: NOW,
    };
    const { db, log } = recording(last);

    expect(await appendStatus(db, SESSION, PAUSED, NOW)).toBeUndefined();

    expect(log.map((one) => one[1])).toStrictEqual(["findOne"]);
  });
});

describe("appendRecordStatus", () => {
  it("writes the change a record status makes, and nothing for a status that is no thread status", async () => {
    const written = recording();
    const none = recording();

    await appendRecordStatus(written.db, SESSION, THREAD, {
      status: "running",
      context: undefined,
      at: NOW,
    });
    await appendRecordStatus(none.db, SESSION, THREAD, {
      status: "queued",
      context: undefined,
      at: NOW,
    });

    expect(written.log.map((one) => one[1])).toStrictEqual(["findOne", "findOne", "insertOne"]);
    expect(none.log.map((one) => one[1])).toStrictEqual(["findOne"]);
  });
});

describe("the history and its removal", () => {
  it("the history is the thread's documents oldest first", async () => {
    const { db, log } = recording();

    expect(await historyOf(db, THREAD)).toStrictEqual([]);

    expect(log).toStrictEqual([
      [Collections.ThreadStatusTransitions, "find", THREAD],
      [Collections.ThreadStatusTransitions, "sort", { seq: 1 }],
    ]);
  });

  it("the thread's documents are removed, in the caller's session when it has one", async () => {
    const withSession = recording();
    const without = recording();

    await forgottenStatus(withSession.db, THREAD, SESSION);
    await forgottenStatus(without.db, THREAD);

    expect(withSession.log).toStrictEqual([
      [Collections.ThreadStatusTransitions, "deleteMany", THREAD, { session: SESSION }],
    ]);
    expect(without.log).toStrictEqual([
      [Collections.ThreadStatusTransitions, "deleteMany", THREAD, {}],
    ]);
  });
});
