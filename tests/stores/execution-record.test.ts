import { ComponentKind, ExecutionRecordStatus, PauseAnswerer, PauseResolution } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { testDatabase } from "../support/database.js";
import { Collections } from "../../src/index.js";
import { connectionTo } from "../support/stores.js";
import { outcomeOf, recordOf, recordsOn } from "../support/stores.js";
import type { PauseAnswer } from "../../src/stores/records/record-documents.js";

/**
 * Every method of MongoExecutionRecordRepository beyond the contract: what eval, replay,
 * golden sets, memory and the pause log read — as the core's Tern store answers them.
 */
const database = testDatabase();
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

const answerOf = (stepKey: string, askedAt: string): PauseAnswer => ({
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
  answeredBy: PauseAnswerer.Channel,
  responder: "manager-17",
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

  it("lastTerns: the newest records of a thread, oldest first; another tenant's thread is its own", async () => {
    const records = recordsOn(database.url());
    const { threadId } = await threadWith(records, [Answered, Answered, Answered]);

    const last = await records.lastTerns("default", threadId, 2);

    expect(last.map((record) => record.runId)).toEqual(["run-2", "run-3"]);
    expect(await records.lastTerns("acme", threadId, 2)).toEqual([]);
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
        terns: 3,
        scored: 2,
        meanScore: expect.closeTo(0.7),
        costUsd: expect.closeTo(0.03),
      },
      { promptVersion: "p2", terns: 1, scored: 0, meanScore: null, costUsd: expect.closeTo(0.01) },
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
      fromTernId: one,
      toTernId: two,
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
        fromTernId: ids[from] ?? "",
        toTernId: ids[to] ?? "",
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
    await records.savePauseAnswer("default", "root-log", { ...earlier, responder: "someone else" });

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
    ).rejects.toThrow('a stored pause answer is not readable: {"role":1}');
  });
});
