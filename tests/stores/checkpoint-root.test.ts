/**
 * agbossjs/agboss#1321d on MongoDB: each checkpoint and pending write stores its tree's root
 * execution id (`configurable.root_execution_id`); `deleteThread(rootExecutionId)` removes the
 * thread and every thread with that stored root — never a range or a prefix of thread ids.
 */
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";
import { Collections, MongoCheckpointSaver } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();

const at = (thread: string, root?: string) => ({
  configurable: {
    thread_id: thread,
    checkpoint_ns: "",
    ...(root === undefined ? {} : { root_execution_id: root }),
  },
});

async function write(saver: MongoCheckpointSaver, thread: string, root?: string): Promise<void> {
  const put = await saver.put(
    at(thread, root),
    { ...emptyCheckpoint(), id: `id-${thread}` },
    { source: "loop", step: 1, parents: {} },
    {},
  );
  await saver.putWrites(
    { configurable: { ...put.configurable, ...at(thread, root).configurable } },
    [["ch", 1]],
    "task-1",
  );
}

describe("the root of a checkpoint", () => {
  it("is stored with the checkpoint and with its pending writes: the one named, else the thread itself", async () => {
    const connection = connectionTo(database.url());
    const saver = new MongoCheckpointSaver(connection);
    await write(saver, "root-a/child/x", "root-a");
    await write(saver, "lonely");

    const roots = async (name: string) =>
      (await connection.db.collection<{ threadId: string; rootId: string }>(name).find().toArray())
        .map((one) => [one.threadId, one.rootId])
        .sort();
    for (const name of [Collections.Checkpoints, Collections.CheckpointWrites])
      expect(await roots(name)).toEqual([
        ["lonely", "lonely"],
        ["root-a/child/x", "root-a"],
      ]);
  });

  it("deleteThread of a root removes the threads that name it, at any depth, and no thread that only looks like one", async () => {
    const connection = connectionTo(database.url());
    const saver = new MongoCheckpointSaver(connection);
    const doomed = ["root", "root/child/a", "root/child/a/child/b"];
    const kept: readonly (readonly [string, string])[] = [
      ["root2", "root2"],
      ["root-child", "root-child"],
      ["root/children", "root/children"],
      ["other/child/root", "other"],
      ["root0", "root0"],
      ["root/child/x-evil", "root/child/x-evil"],
    ];
    for (const id of doomed) await write(saver, id, "root");
    for (const [id, root] of kept) await write(saver, id, root);

    await saver.deleteThread("root");

    for (const name of [Collections.Checkpoints, Collections.CheckpointWrites]) {
      const left = await connection.db.collection<{ threadId: string }>(name).find().toArray();
      expect(left.map((one) => one.threadId).sort()).toEqual(kept.map(([id]) => id).sort());
    }
  });

  it("deleteThread of an id no tree has removes nothing", async () => {
    const connection = connectionTo(database.url());
    const saver = new MongoCheckpointSaver(connection);
    await write(saver, "one", "one");

    await saver.deleteThread("nothing");

    expect(await connection.db.collection(Collections.Checkpoints).countDocuments()).toBe(1);
  });
});
