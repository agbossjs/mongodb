import { emptyCheckpoint, type CheckpointMetadata } from "@langchain/langgraph-checkpoint";
import { Binary } from "mongodb";
import { describe, expect, it } from "vitest";
import { Collections, MongoCheckpointSaver } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#962: `latestByStep` — the newest checkpoint of a thread's namespace by
 * `(step, id)` — is one sorted find on the `latest_by_step` index on 10 000 checkpoints, and gives a
 * checkpoint written before the index its step on the first read of its thread.
 */
const database = testDatabase();
const at = (thread: string, namespace = "") => ({
  configurable: { thread_id: thread, checkpoint_ns: namespace },
});

/** Puts a checkpoint (one document: the step is in it). */
const put = (
  saver: MongoCheckpointSaver,
  where: ReturnType<typeof at>,
  id: string,
  step: number | undefined,
) =>
  saver.put(
    where,
    { ...emptyCheckpoint(), id, channel_values: { marker: `${id}@${String(step)}` } },
    // a checkpoint with no step: the metadata as an older writer left it
    step === undefined
      ? JSON.parse('{"source":"loop","parents":{}}')
      : ({ source: "loop", step, parents: {} } satisfies CheckpointMetadata),
    { marker: (step ?? 0) + 1 },
  );

describe("agbossjs/agboss#962: MongoCheckpointSaver.latestByStep", () => {
  it("AC1: 10 000 checkpoints — one sorted find walks the index: 1 document examined, no in-memory sort", async () => {
    const connection = connectionTo(database.url());
    const saver = new MongoCheckpointSaver(connection);
    const collection = connection.db.collection(Collections.Checkpoints);
    const json = new Binary(Buffer.from(JSON.stringify({ ...emptyCheckpoint(), id: "x" })));
    const meta = (step: number) =>
      new Binary(Buffer.from(JSON.stringify({ source: "loop", step, parents: {} })));
    await collection.insertMany(
      Array.from({ length: 10_000 }, (_, n) => ({
        _id: `busy|${String(n)}`,
        tenantId: "default",
        threadId: "busy",
        namespace: "",
        checkpointId: `id-${String(n).padStart(6, "0")}`,
        parentCheckpointId: null,
        checkpointType: "json",
        checkpoint: json,
        metadataType: "json",
        metadata: meta(n),
        step: n,
      })),
    );

    const plan = await collection
      .find({ threadId: "busy", namespace: "" })
      .sort({ step: -1, checkpointId: -1 })
      .limit(1)
      .explain("executionStats");
    const stats = JSON.stringify(plan["queryPlanner"]?.["winningPlan"]);
    expect(stats).toContain("latest_by_step");
    expect(stats).not.toContain('"stage":"SORT"');
    expect(plan["executionStats"]?.["totalDocsExamined"]).toBe(1);
    expect((await saver.latestByStep(at("busy")))?.config.configurable?.checkpoint_id).toBe(
      "id-009999",
    );
  });

  it("AC1: it answers what the full scan answers on random histories — ties by byte, a missing or fractional step", async () => {
    const saver = new MongoCheckpointSaver(connectionTo(database.url()));
    const ids = ["a", "b", "B", "Z", "a-1", "A-1", "0f", "zz", "m"];
    const places = [at("random"), at("random", "child")];
    let seed = 962;
    const next = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const stepOf = (metadata: CheckpointMetadata | undefined): number =>
      typeof metadata?.step === "number" ? metadata.step : -2;
    for (let round = 0; round < 40; round += 1) {
      const where = places[Math.floor(next() * places.length)] ?? at("random");
      const step = next() < 0.15 ? undefined : next() < 0.15 ? 1.5 : Math.floor(next() * 6) - 1;
      await put(saver, where, ids[Math.floor(next() * ids.length)] ?? "a", step);
      for (const place of places) {
        const listed = [];
        for await (const tuple of saver.list(place)) listed.push(tuple);
        listed.sort(
          (a, b) =>
            stepOf(b.metadata) - stepOf(a.metadata) ||
            (a.checkpoint.id < b.checkpoint.id ? 1 : a.checkpoint.id > b.checkpoint.id ? -1 : 0),
        );
        expect((await saver.latestByStep(place))?.checkpoint.id).toBe(listed[0]?.checkpoint.id);
      }
    }
    expect(await saver.latestByStep(at("nobody"))).toBeUndefined();
  });

  it("AC1: a read while another connection writes is a whole stored checkpoint, never going back", async () => {
    const writer = new MongoCheckpointSaver(connectionTo(database.url()));
    const reader = new MongoCheckpointSaver(connectionTo(database.url()));
    let written = 0;
    const writes = (async () => {
      for (let step = 0; step < 30; step += 1) {
        await put(writer, at("live"), `id-${String(step).padStart(3, "0")}`, step);
        written = step + 1;
      }
    })();
    let seen = -1;
    while (written < 30) {
      const tuple = await reader.latestByStep(at("live"));
      if (tuple === undefined) continue;
      const step = Number(tuple.checkpoint.id.slice(3));
      expect(tuple.checkpoint.channel_values).toEqual({
        marker: `${tuple.checkpoint.id}@${String(step)}`,
      });
      expect(step).toBeGreaterThanOrEqual(seen);
      seen = step;
    }
    await writes;
    expect((await reader.latestByStep(at("live")))?.checkpoint.id).toBe("id-029");
  });

  it("AC1: checkpoints written before the index have no step: the first read gives each its own, a populated and an empty thread alike", async () => {
    const connection = connectionTo(database.url());
    const saver = new MongoCheckpointSaver(connection);
    const collection = connection.db.collection(Collections.Checkpoints);
    for (const [id, step] of [
      ["id-1", 3],
      ["id-2", undefined],
      ["id-3", 3],
      ["id-0", 9],
    ] as const)
      await put(saver, at("old"), id, step);
    await put(saver, at("old", "child"), "child-1", 1);
    await collection.updateMany({ threadId: "old" }, { $unset: { step: "" } });

    expect((await saver.latestByStep(at("old")))?.checkpoint.id).toBe("id-0");
    expect(
      await collection.countDocuments({ threadId: "old", namespace: "", step: { $exists: false } }),
    ).toBe(0);
    expect(
      await collection.countDocuments({
        threadId: "old",
        namespace: "child",
        step: { $exists: false },
      }),
    ).toBe(1);
    expect(await collection.findOne({ threadId: "old", checkpointId: "id-2" })).toMatchObject({
      step: -2,
    });
    expect((await saver.latestByStep(at("old", "child")))?.checkpoint.id).toBe("child-1");
    expect(await collection.countDocuments({ threadId: "old", step: { $exists: false } })).toBe(0);
    expect(await saver.latestByStep(at("empty-thread"))).toBeUndefined();
  });
});
