import { pauseAnswerRecordOfValue, StoreOutcomeUnknownError } from "@agboss/core/stores";
import {
  ComponentKind,
  ExecutionRecordStatus,
  PauseAnswerer,
  RandomIdGenerator,
  PauseResolution,
  type PauseAnswerRecord,
} from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { Collection, FindCursor } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestApplicationContext } from "../support/application-context.js";
import { testDatabase } from "../support/database.js";
import { Collections, MongoExecutionRecordRepository } from "../../src/index.js";
import { connectionTo } from "../support/stores.js";
import { outcomeOf, recordOf, recordsOn } from "../support/stores.js";

/**
 * Every method of MongoExecutionRecordRepository beyond the contract: what eval, replay,
 * golden sets, memory and the pause log read — as the core's Turn store answers them.
 */
const database = testDatabase();

afterEach(() => {
  vi.restoreAllMocks();
});
const { Answered, Running, Paused, Failed } = ExecutionRecordStatus;

/** A thread of `desk-workflow` with records of `statuses`, in that order; their ids. */
async function threadWith(
  records: ReturnType<typeof recordsOn>,
  statuses: readonly ExecutionRecordStatus[],
  fields: Parameters<typeof recordOf>[2] = {},
): Promise<{ readonly threadId: string; readonly ids: readonly string[] }> {
  const threadId = await records.createThread({ workflow: "desk-workflow", tenantId: "default" });
  const ids: string[] = [];
  for (const [index, status] of statuses.entries())
    ids.push(
      (
        await records.append(
          recordOf(threadId, status, { runId: `run-${String(index + 1)}`, ...fields }),
        )
      ).id,
    );
  return { threadId, ids };
}

const answerOf = (stepKey: string, askedAt: string): PauseAnswerRecord =>
  pauseAnswerRecordOfValue({
    pauseId: undefined,
    executionId: "run-1",
    step: {
      component: {
        name: "clerk-agent",
        kind: ComponentKind.Agent,
        promptHash: undefined,
        schemaHash: undefined,
      },
      nodeId: "clerk-agent",
      visitNumber: 1,
      idempotencyKey: stepKey,
      callId: "call-1",
      itemIndex: undefined,
      copyNumber: 1,
      toolLoopIteration: 2,
      validationAttempts: 0,
    },
    role: "refund-approval",
    answerer: PauseAnswerer.Channel,
    answeredBy: "manager-17",
    resolution: PauseResolution.Replied,
    askedAt,
    resolvedAt: "2026-01-05T10:00:00.000Z",
    decision: { approved: true },
  });

describe("MongoExecutionRecordRepository", () => {
  it("threads: ids from the IdGenerator, a caller's own id kept, the first creation wins", async () => {
    const records = recordsOn(database.url());

    const made = await records.createThread({ workflow: "desk-workflow", tenantId: "default" });
    const own = await records.createThread({
      workflow: "desk-workflow",
      tenantId: "default",
      threadId: "my-thread",
      ownerId: "dana",
    });
    const again = await records.createThread({
      workflow: "desk-workflow",
      tenantId: "default",
      threadId: "my-thread",
      ownerId: "eve",
    });

    expect(made).toMatch(/^thread-\d+$/);
    expect([own, again]).toEqual(["my-thread", "my-thread"]);
    expect(await records.threadOwner("desk-workflow", "default", "my-thread")).toEqual({
      owner: "dana",
    });
    expect(await records.threadOwner("desk-workflow", "default", made)).toEqual({
      owner: undefined,
    });
    expect(await records.threadOwner("desk-workflow", "acme", made)).toBeUndefined();
    expect(await records.hasThread("desk-workflow", "acme", made)).toBe(false);
  });

  it("append: a new id and the Clock's time; read back as written", async () => {
    const clock = new VirtualClock(new Date("2026-03-01T12:00:00.000Z"));
    const records = recordsOn(database.url(), clock);
    const threadId = await records.createThread({ workflow: "desk-workflow", tenantId: "default" });

    const appended = await records.append(recordOf(threadId, Answered, { replayOf: "earlier" }));

    expect(appended.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(appended.createdAt).toBe("2026-03-01T12:00:00.000Z");
    expect(await records.byIds([appended.id])).toEqual([appended]);
    expect(await records.byIds([])).toEqual([]);
  });

  it("complete writes the outcome whatever the status; completeIfStatus only from the expected one", async () => {
    const records = recordsOn(database.url());
    const { ids } = await threadWith(records, [Paused]);
    const [id = ""] = ids;

    await records.complete(id, outcomeOf(Answered, { costUsd: 0.5, route: ["start", "finish"] }));
    const late = await records.completeIfStatus(id, Paused, outcomeOf(Failed));
    const [stored] = await records.byIds([id]);

    expect(late).toBe(false);
    expect(stored).toMatchObject({ status: "answered", costUsd: 0.5, route: ["start", "finish"] });
  });

  it("the paused -> running mark of an answer, written with no lease on several instances at once: exactly one lands", async () => {
    const stores = Array.from({ length: 4 }, () => recordsOn(database.url()));
    await Promise.all(stores.map((store) => store.ping()));
    for (let round = 0; round < 8; round += 1) {
      const { ids } = await threadWith(stores[0] ?? recordsOn(database.url()), [Paused]);
      const [id = ""] = ids;
      let release: () => void = () => undefined;
      const go = new Promise<void>((resolve) => {
        release = resolve;
      });
      const running = stores.map(async (store, index) => {
        await go;
        return store.completeIfStatus(id, Paused, outcomeOf(Running, { costUsd: index + 1 }));
      });
      release();

      const marks = await Promise.all(running);

      expect(marks.filter(Boolean)).toHaveLength(1);
      const [stored] = (await stores[0]?.byIds([id])) ?? [];
      expect(stored?.status).toBe("running");
      expect(stored?.costUsd).toBe(marks.indexOf(true) + 1);
      // the answer that lost finds the record already moved: a second mark from paused never lands
      expect(
        await stores[1]?.completeIfStatus(id, Paused, outcomeOf(Running, { costUsd: 9 })),
      ).toBe(false);
    }
  });

  it("a thread id created on several instances at once is created once: its first owner is kept", async () => {
    const stores = Array.from({ length: 4 }, () => recordsOn(database.url()));
    await Promise.all(stores.map((store) => store.ping()));
    for (let round = 0; round < 8; round += 1) {
      const threadId = `shared-${String(round)}`;
      let release: () => void = () => undefined;
      const go = new Promise<void>((resolve) => {
        release = resolve;
      });
      const running = stores.map(async (store, index) => {
        await go;
        return store.createThread({
          workflow: "desk-workflow",
          tenantId: "default",
          threadId,
          ownerId: `owner-${String(index)}`,
        });
      });
      release();

      const made = await Promise.all(running);

      expect(made).toEqual(stores.map(() => threadId));
      const kept = await stores[0]?.threadOwner("desk-workflow", "default", threadId);
      const first = await connectionTo(database.url())
        .db.collection(Collections.Threads)
        .countDocuments({ threadId });
      expect(first).toBe(1);
      expect(kept?.owner).toMatch(/^owner-[0-3]$/);
    }
  });

  it("a status write for an id no record has changes nothing", async () => {
    const records = recordsOn(database.url());

    expect(await records.completeIfStatus("no-such-id", Paused, outcomeOf(Running))).toBe(false);
  });

  it("ping is the connection's own ping", async () => {
    const connection = connectionTo(database.url());
    const ping = vi.spyOn(connection, "ping").mockResolvedValue();

    await new MongoExecutionRecordRepository(
      connection,
      new VirtualClock(),
      new TestApplicationContext({}),
      new RandomIdGenerator(),
    ).ping();

    expect(ping).toHaveBeenCalledOnce();
  });

  it("a thread's insert that fails for any reason but a taken id is thrown, whoever's id it was", async () => {
    const records = recordsOn(database.url());
    const broken = new Error("the insert broke");
    const insert = vi.spyOn(Collection.prototype, "insertOne").mockRejectedValue(broken);

    await expect(
      records.createThread({ workflow: "desk-workflow", tenantId: "default", threadId: "own" }),
    ).rejects.toThrow(StoreOutcomeUnknownError);
    await expect(
      records.createThread({ workflow: "desk-workflow", tenantId: "default" }),
    ).rejects.toThrow(StoreOutcomeUnknownError);

    expect(insert).toHaveBeenCalledTimes(2);
  });

  it("complete keeps the route and the steps as written", async () => {
    const records = recordsOn(database.url());
    const { ids } = await threadWith(records, [Paused]);
    const [id = ""] = ids;
    const steps = [
      { agent: "clerk", content: "looked it up" },
      { agent: "desk", content: "paid" },
    ];

    await records.complete(id, outcomeOf(Answered, { route: ["start", "desk"], steps }));

    expect((await records.byIds([id]))[0]).toMatchObject({ route: ["start", "desk"], steps });
  });

  it("the pause log is read in the order asked, whatever order it was kept in", async () => {
    const records = recordsOn(database.url());
    await records.savePauseAnswer(
      "default",
      "tree-order",
      answerOf("late", "2026-01-05T09:30:00.000Z"),
    );
    await records.savePauseAnswer(
      "default",
      "tree-order",
      answerOf("early", "2026-01-05T08:30:00.000Z"),
    );

    const log = await records.findPauseAnswersByTenantIdAndRootExecutionId("default", "tree-order");

    expect(log.map((entry) => entry.step.idempotencyKey)).toEqual(["early", "late"]);
  });

  it("the pause log asks for its order, by the time asked and then the order kept; an index is not assumed", async () => {
    const records = recordsOn(database.url());
    await records.savePauseAnswer(
      "default",
      "tree-sorted",
      answerOf("k", "2026-01-05T08:30:00.000Z"),
    );
    const sort = vi.spyOn(FindCursor.prototype, "sort");

    await records.findPauseAnswersByTenantIdAndRootExecutionId("default", "tree-sorted");

    expect(sort).toHaveBeenCalledOnce();
    expect(sort).toHaveBeenCalledWith({ askedAt: 1, seq: 1 });
  });

  it("a pause log entry that is no JSON is refused, naming the tree's execution", async () => {
    const records = recordsOn(database.url());
    await records.savePauseAnswer(
      "default",
      "tree-damaged",
      answerOf("k", "2026-01-05T08:30:00.000Z"),
    );
    await connectionTo(database.url())
      .db.collection(Collections.PauseAnswers)
      .updateOne({ rootExecutionId: "tree-damaged" }, { $set: { record: "{not json" } });

    const refused = await records
      .findPauseAnswersByTenantIdAndRootExecutionId("default", "tree-damaged")
      .catch((error: unknown) => error);

    expect(refused).toHaveProperty("message", expect.stringContaining("tree-damaged"));
  });

  it("lastTurns: the newest records of a thread, oldest first; another tenant's thread is its own", async () => {
    const records = recordsOn(database.url());
    const { threadId } = await threadWith(records, [Answered, Answered, Answered]);

    const last = await records.lastTurns("default", threadId, 2);

    expect(last.map((record) => record.runId)).toEqual(["run-2", "run-3"]);
    expect(await records.lastTurns("acme", threadId, 2)).toEqual([]);
  });

  it("findByStatus: a page after a record, oldest first", async () => {
    const records = recordsOn(database.url());
    const { ids } = await threadWith(records, [Failed, Running, Failed, Failed]);

    const failed = await records.findByStatus(Failed, 10, ids[0]);

    expect(failed.map((record) => record.id)).toEqual([ids[2], ids[3]]);
  });

  it("byVersion: originals of a prompt version, a running one and a replay left out", async () => {
    const records = recordsOn(database.url());
    const { ids } = await threadWith(records, [Answered, Running, Failed], {
      bundle: "version-workflow",
    });
    await threadWith(records, [Answered], { bundle: "version-workflow", replayOf: ids[0] });
    await threadWith(records, [Answered], { bundle: "version-workflow", promptVersion: "p2" });

    const originals = await records.byVersion("version-workflow", "p1", 10);

    expect(originals.map((record) => record.id)).toEqual([ids[0], ids[2]]);
    expect(await records.byVersion("version-workflow", "p1", 1)).toHaveLength(1);
  });

  it("scores: unscored answered records, the mean of a set, the summary per prompt version", async () => {
    const records = recordsOn(database.url());
    const { ids } = await threadWith(records, [Answered, Answered, Failed, Running], {
      bundle: "scored-workflow",
    });
    await threadWith(records, [Answered], { bundle: "scored-workflow", promptVersion: "p2" });
    const [first = "", second = ""] = ids;

    await records.saveScore(first, "judge", 0.8);
    await records.saveScore(first, "judge", 0.6);

    expect((await records.unscored("scored-workflow", "p1", 10)).map((r) => r.id)).toEqual([
      second,
    ]);
    expect(await records.unscored("scored-workflow", undefined, 10)).toHaveLength(2);
    expect(await records.meanScore([first, second])).toBeCloseTo(0.7);
    expect(await records.meanScore([second])).toBeNull();
    expect(await records.summary("scored-workflow")).toEqual([
      {
        promptVersion: "p1",
        turns: 3,
        scored: 2,
        meanScore: expect.closeTo(0.7),
        costUsd: expect.closeTo(0.03),
      },
      { promptVersion: "p2", turns: 1, scored: 0, meanScore: null, costUsd: expect.closeTo(0.01) },
    ]);
    expect(await records.summary("no-such-workflow")).toEqual([]);
  });

  it("config versions: stored once, drift on another hash of the same length, snapshots in order", async () => {
    const clock = new VirtualClock(new Date("2026-03-01T12:00:00.000Z"));
    const records = recordsOn(database.url(), clock);

    const first = await records.rememberConfig("config-workflow", "1.0.0", "aaaa", '{"a":1}');
    const same = await records.rememberConfig("config-workflow", "1.0.0", "aaaa", '{"a":1}');
    await clock.advance("1s");
    const drifted = await records.rememberConfig("config-workflow", "1.0.0", "bbbb", '{"a":2}');
    const olderScheme = await records.rememberConfig("config-workflow", "1.0.0", "cc", '{"a":3}');

    expect([first, same, drifted, olderScheme]).toEqual([
      { drift: false },
      { drift: false },
      { drift: true },
      { drift: false },
    ]);
    const snapshots = await records.configSnapshots("config-workflow", "1.0.0");
    expect(snapshots.slice(0, 2)).toEqual([
      {
        version: "1.0.0",
        hash: "aaaa",
        snapshot: '{"a":1}',
        firstSeen: "2026-03-01T12:00:00.000Z",
      },
      {
        version: "1.0.0",
        hash: "bbbb",
        snapshot: '{"a":2}',
        firstSeen: "2026-03-01T12:00:01.000Z",
      },
    ]);
  });

  it("recentOriginals: the newest original answered records, oldest first", async () => {
    const records = recordsOn(database.url());
    const { ids } = await threadWith(records, [Answered, Failed, Answered, Answered], {
      bundle: "recent-workflow",
    });

    const recent = await records.recentOriginals("recent-workflow", 2);

    expect(recent.map((record) => record.id)).toEqual([ids[2], ids[3]]);
  });

  it("memory: turns after the compaction's last summary, turns before one, a turn's number", async () => {
    const records = recordsOn(database.url());
    const { threadId, ids } = await threadWith(records, [Answered, Answered, Answered, Answered]);
    const [one = "", two = "", three = "", four = ""] = ids;

    const summary = await records.addSummary({
      tenantId: "default",
      threadId,
      bundle: "desk-workflow",
      compaction: "rolling",
      fromTurnId: one,
      toTurnId: two,
      turns: 2,
      text: "asked about order 7",
      costUsd: 0.002,
    });

    expect(summary).toMatchObject({ id: expect.any(String), compaction: "rolling", turns: 2 });
    expect((await records.uncovered("default", threadId, "rolling")).map((r) => r.id)).toEqual([
      three,
      four,
    ]);
    expect(await records.uncovered("default", threadId, "other")).toHaveLength(4);
    expect((await records.before("default", threadId, four, 2)).map((r) => r.id)).toEqual([
      two,
      three,
    ]);
    expect(await records.turnNumber("default", threadId, three)).toBe(3);
  });

  it("summaries: the compaction's newest ones, oldest first, and their count", async () => {
    const records = recordsOn(database.url());
    const { threadId, ids } = await threadWith(records, [Answered, Answered, Answered]);
    const summarise = (from: number, to: number, compaction = "rolling") =>
      records.addSummary({
        tenantId: "default",
        threadId,
        bundle: "desk-workflow",
        compaction,
        fromTurnId: ids[from] ?? "",
        toTurnId: ids[to] ?? "",
        turns: to - from + 1,
        text: `turns ${String(from)}-${String(to)}`,
        costUsd: 0.001,
      });
    await summarise(0, 0);
    await summarise(1, 1);
    await summarise(2, 2);
    await summarise(0, 2, "other");

    const latest = await records.latestSummaries("default", threadId, "rolling", 2);

    expect(latest.map((summary) => summary.text)).toEqual(["turns 1-1", "turns 2-2"]);
    expect(await records.summaryCount("default", threadId, "rolling")).toBe(3);
    expect(await records.summaryCount("default", threadId, "none")).toBe(0);
  });

  it("the pause log: kept once per step, read per tree in the order asked", async () => {
    const records = recordsOn(database.url());
    const later = answerOf("run-1:clerk:2", "2026-01-05T09:05:00.000Z");
    const earlier = answerOf("run-1:clerk:1", "2026-01-05T09:00:00.000Z");

    await records.savePauseAnswer("default", "root-log", later);
    await records.savePauseAnswer("default", "root-log", earlier);
    await records.savePauseAnswer("default", "root-log", {
      ...earlier,
      answeredBy: "someone else",
    });

    const log = await records.findPauseAnswersByTenantIdAndRootExecutionId("default", "root-log");
    expect(log).toEqual([earlier, later]);
    expect(await records.findPauseAnswersByTenantIdAndRootExecutionId("acme", "root-log")).toEqual(
      [],
    );
  });

  it("a stored record that is not one fails loudly when read", async () => {
    const records = recordsOn(database.url());
    const { ids } = await threadWith(records, [Answered]);
    const { db } = connectionTo(database.url());
    await db
      .collection<{ _id: string; status: string }>(Collections.ExecutionRecords)
      .updateOne({ _id: ids[0] ?? "" }, { $set: { status: "lost" } });
    await db.collection<{ _id: string }>(Collections.PauseAnswers).insertOne({
      _id: "bad",
      tenantId: "default",
      rootExecutionId: "root-bad",
      askedAt: "",
      seq: 1,
      record: '{"role":1}',
    } as { _id: string });

    await expect(records.byIds(ids)).rejects.toThrow();
    await expect(
      records.findPauseAnswersByTenantIdAndRootExecutionId("default", "root-bad"),
    ).rejects.toThrow(/^a stored pause answer is not readable: the field\(s\) .*executionId/);
  });
});
