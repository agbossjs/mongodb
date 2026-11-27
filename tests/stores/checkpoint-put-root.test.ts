/**
 * agbossjs/agboss#1321d: `put` gives back a config that names the tree's root when it is not the thread
 * itself, so the next `put` (and the writes of the checkpoint) keep the tree they belong to and
 * `deleteThread(root)` finds them all — what the contract's two-step threads rely on.
 */
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";
import { MongoCheckpointSaver } from "../../src/index.js";

/** A saver on a fake database: every `replaceOne` is logged. */
function saverOn() {
  const replaced: { threadId: string; rootId: string; checkpointId: string }[] = [];
  const collection = {
    replaceOne: (
      _filter: unknown,
      document: { threadId: string; rootId: string; checkpointId: string },
    ) => {
      replaced.push(document);
      return Promise.resolve({});
    },
  };
  const connection = { db: { collection: () => collection } } as never;
  return { saver: new MongoCheckpointSaver(connection), replaced };
}

const put = (saver: MongoCheckpointSaver, config: object, id: string) =>
  saver.put(config, { ...emptyCheckpoint(), id }, { source: "input", step: 1, parents: {} }, {});

describe("MongoCheckpointSaver.put's returned config", () => {
  it("names the root of a thread of another root, so the next put keeps it", async () => {
    const { saver, replaced } = saverOn();
    const first = await put(
      saver,
      { configurable: { thread_id: "root/child/a", checkpoint_ns: "", root_execution_id: "root" } },
      "c1",
    );

    expect(first.configurable).toMatchObject({ root_execution_id: "root", checkpoint_id: "c1" });
    await put(saver, first, "c2");

    expect(replaced.map((one) => [one.checkpointId, one.rootId])).toEqual([
      ["c1", "root"],
      ["c2", "root"],
    ]);
  });

  it("a thread that is its own root gives the plain config", async () => {
    const { saver } = saverOn();

    const config = await put(saver, { configurable: { thread_id: "t", checkpoint_ns: "" } }, "c1");

    expect(config).toStrictEqual({
      configurable: { thread_id: "t", checkpoint_ns: "", checkpoint_id: "c1" },
    });
  });
});
