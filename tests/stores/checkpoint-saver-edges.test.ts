/**
 * agbossjs/mongodb#104: what the checkpoint saver does that the shard's mutants drop — the newest
 * checkpoint by id, a list newest first, the pending writes of one checkpoint in the order of their
 * calls and places, a thread deleted alone, the writes of a call in one transaction, ordered, and
 * none for no writes, the backfill of a step as one unordered bulk write, the names of the errors.
 */
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Collections, MongoCheckpointSaver, MongoConnection } from "../../src/index.js";
import { commandsOf, nameOf, plain } from "../support/command-log.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

vi.mock("mongodb", async (importOriginal) => {
  const { reportingCommands } = await import("../support/command-log.js");
  return reportingCommands(await importOriginal());
});

const database = testDatabase();
const CHECKPOINTS = Collections.Checkpoints;
const WRITES = Collections.CheckpointWrites;

const at = (thread: string, namespace = "") => ({
  configurable: { thread_id: thread, checkpoint_ns: namespace },
});
const named = (thread: string, id: string, namespace = "") => ({
  configurable: { thread_id: thread, checkpoint_ns: namespace, checkpoint_id: id },
});

function setup() {
  const connection = connectionTo(database.url());
  return { connection, saver: new MongoCheckpointSaver(connection) };
}

const put = (saver: MongoCheckpointSaver, thread: string, id: string, step = 0) =>
  saver.put(at(thread), { ...emptyCheckpoint(), id }, { source: "loop", step, parents: {} }, {});

afterEach(async () => {
  const { connection } = setup();
  for (const name of [CHECKPOINTS, WRITES, Collections.Sequences])
    await connection.db.collection(name).deleteMany({});
  vi.restoreAllMocks();
});

describe("a config with no thread names the operation that was given it", () => {
  it.each(["getTuple", "latestByStep", "put", "putWrites"])("%s", async (operation) => {
    const { saver } = setup();
    const calls: Record<string, () => Promise<unknown>> = {
      getTuple: () => saver.getTuple({ configurable: {} }),
      latestByStep: () => saver.latestByStep({ configurable: {} }),
      put: () =>
        saver.put(
          { configurable: {} },
          emptyCheckpoint(),
          { source: "loop", step: 0, parents: {} },
          {},
        ),
      putWrites: () => saver.putWrites({ configurable: {} }, [["c", 1]], "task"),
    };

    await expect(calls[operation]?.()).rejects.toThrow(
      `MongoCheckpointSaver.${operation}: the config has no configurable.thread_id`,
    );
  });

  it("a write's config with a thread and no checkpoint is refused, with its reason", async () => {
    const { saver } = setup();

    await expect(saver.putWrites(at("t"), [["c", 1]], "task")).rejects.toThrow(
      "MongoCheckpointSaver.putWrites: the config has no checkpoint_id",
    );
  });
});

describe("ping", () => {
  it("answers on a server, and rejects on a deployment that does not answer", async () => {
    await expect(setup().saver.ping()).resolves.toBeUndefined();

    const lost = new MongoConnection({
      url: "mongodb://127.0.0.1:1/?replicaSet=rs0&serverSelectionTimeoutMS=200",
    });
    try {
      await expect(new MongoCheckpointSaver(lost).ping()).rejects.toThrow();
    } finally {
      await lost.onDestroy();
    }
  });
});

describe("getTuple", () => {
  it("with no checkpoint id: the newest by id, whatever the order they were written in", async () => {
    const { saver } = setup();
    await put(saver, "t", "0001");
    await put(saver, "t", "0003");
    await put(saver, "t", "0002");

    expect((await saver.getTuple(at("t")))?.checkpoint.id).toBe("0003");
    expect((await saver.getTuple(named("t", "0002")))?.checkpoint.id).toBe("0002");
  });

  it("asks by thread and namespace alone for the newest, sorted by id, and names the id when it has one", async () => {
    const { connection, saver } = setup();
    await put(saver, "t", "0001");
    const sent = commandsOf(connection);

    await saver.getTuple(at("t"));
    await saver.getTuple(named("t", "0001"));

    const [latest, byId] = sent;
    expect(Object.keys(latest?.command.filter as object).sort()).toEqual(["namespace", "threadId"]);
    expect(plain(latest?.command.sort)).toEqual({ checkpointId: -1 });
    expect(byId?.command.filter).toMatchObject({ checkpointId: "0001" });
  });
});

describe("list is newest first", () => {
  it("by id descending, whatever the order they were written in, and `limit` takes the newest", async () => {
    const { saver } = setup();
    for (const id of ["0002", "0001", "0003"]) await put(saver, "t", id);

    const ids: string[] = [];
    for await (const tuple of saver.list(at("t"))) ids.push(tuple.checkpoint.id);
    const newest: string[] = [];
    for await (const tuple of saver.list(at("t"), { limit: 2 })) newest.push(tuple.checkpoint.id);

    expect(ids).toEqual(["0003", "0002", "0001"]);
    expect(newest).toEqual(["0003", "0002"]);
  });
});

describe("putWrites", () => {
  it("no writes: nothing is drawn and nothing is sent", async () => {
    const { connection, saver } = setup();
    await put(saver, "t", "0001");
    const sent = commandsOf(connection);

    await saver.putWrites(named("t", "0001"), [], "task-1");

    expect(sent).toEqual([]);
    expect(await connection.db.collection(Collections.Sequences).countDocuments({})).toBe(0);
  });

  it("the writes of a call are one ordered bulk write inside one transaction", async () => {
    const { connection, saver } = setup();
    await put(saver, "t", "0001");
    const sent = commandsOf(connection);

    await saver.putWrites(
      named("t", "0001"),
      [
        ["a", 1],
        ["b", 2],
      ],
      "task-1",
    );

    const bulk = sent.filter((one) => nameOf(one) === `update ${WRITES}`);
    expect(bulk).toHaveLength(1);
    expect(bulk[0]?.inTransaction).toBe(true);
    expect(bulk[0]?.command.ordered).toBe(true);
    expect((bulk[0]?.command.updates as unknown[]).length).toBe(2);
  });
});

describe("the pending writes of a checkpoint", () => {
  it("are its own, never another checkpoint's of the thread", async () => {
    const { saver } = setup();
    await put(saver, "t", "0001");
    await put(saver, "t", "0002");
    await saver.putWrites(named("t", "0001"), [["a", "one"]], "task-1");
    await saver.putWrites(named("t", "0002"), [["b", "two"]], "task-2");

    expect((await saver.getTuple(named("t", "0001")))?.pendingWrites).toEqual([
      ["task-1", "a", "one"],
    ]);
    expect((await saver.getTuple(named("t", "0002")))?.pendingWrites).toEqual([
      ["task-2", "b", "two"],
    ]);
  });

  it("come in the order of their calls, then their places, not the order the server holds them in", async () => {
    const { connection, saver } = setup();
    await put(saver, "t", "0001");
    await saver.putWrites(
      named("t", "0001"),
      [
        ["a", "first"],
        ["b", "second"],
      ],
      "task-1",
    );
    await saver.putWrites(named("t", "0001"), [["c", "third"]], "task-2");
    // the first call's documents written again, so that the server holds them last
    const writes = connection.db.collection(WRITES);
    const first = await writes.find({ taskId: "task-1" }).toArray();
    await writes.deleteMany({ taskId: "task-1" });
    await writes.insertMany(first.reverse());

    const pending = (await saver.getTuple(named("t", "0001")))?.pendingWrites;

    expect(pending).toEqual([
      ["task-1", "a", "first"],
      ["task-1", "b", "second"],
      ["task-2", "c", "third"],
    ]);
  });
});

describe("deleteThread removes a thread's checkpoints and writes, and nothing of another's", () => {
  it("two threads, one deleted", async () => {
    const { connection, saver } = setup();
    for (const thread of ["gone", "kept"]) {
      await put(saver, thread, "0001");
      await saver.putWrites(named(thread, "0001"), [["a", thread]], `task-${thread}`);
    }

    await saver.deleteThread("gone");

    const left = async (name: string): Promise<string[]> => {
      const documents = await connection.db
        .collection<{ threadId: string }>(name)
        .find({})
        .toArray();
      return documents.map((one) => one.threadId);
    };
    expect(await left(CHECKPOINTS)).toEqual(["kept"]);
    expect(await left(WRITES)).toEqual(["kept"]);
  });
});

describe("latestByStep gives a checkpoint written without a step its step, in one unordered bulk write", () => {
  it("reads only the metadata of the ones without a step, writes once, and not again", async () => {
    const { connection, saver } = setup();
    await put(saver, "t", "0001", 4);
    await connection.db.collection(CHECKPOINTS).updateMany({}, { $unset: { step: "" } });
    const sent = commandsOf(connection);

    const first = await saver.latestByStep(at("t"));
    const second = await saver.latestByStep(at("t"));

    expect(first?.checkpoint.id).toBe("0001");
    expect(second?.checkpoint.id).toBe("0001");
    const checkpointCommands = sent.filter((one) => one.collection === CHECKPOINTS);
    const named = (name: string) => checkpointCommands.filter((one) => one.name === name);
    // the look for a checkpoint without a step reads the metadata only, once for each call
    const unsteppedLooks = named("find").filter(
      (one) => JSON.stringify(plain(one.command.projection)) === '{"metadataType":1,"metadata":1}',
    );
    expect(unsteppedLooks).toHaveLength(2);
    expect(unsteppedLooks[0]?.command.filter).toMatchObject({ step: { $exists: false } });
    // the backfill is one unordered bulk write, the first call's: the second finds nothing to do
    expect(named("update")).toHaveLength(1);
    expect(named("update")[0]?.command.ordered).toBe(false);
    // the answer is the newest by step, then id
    const answers = named("find").filter(
      (one) => JSON.stringify(plain(one.command.sort)) === '{"step":-1,"checkpointId":-1}',
    );
    expect(answers).toHaveLength(2);
    expect(
      await connection.db.collection(CHECKPOINTS).findOne({ _id: { $exists: true } }),
    ).toMatchObject({
      step: 4,
    });
  });
});
