import {
  BaseCheckpointSaver,
  emptyCheckpoint,
  type ChannelVersions,
} from "@langchain/langgraph-checkpoint";
import { describe, expect, expectTypeOf, it } from "vitest";
import { MongoCheckpointSaver } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#891 AC4 — `MongoCheckpointSaver` mirrors LangGraph's `BaseCheckpointSaver`
 * exactly: `put(config, checkpoint, metadata, newVersions)`, `putWrites(config, writes, taskId)`,
 * `list(config, options)` with LangGraph's own types, as `@agboss/postgres`'s saver does.
 */
const database = testDatabase();

describe("agbossjs/agboss#891 AC4: MongoCheckpointSaver's signature is LangGraph's", () => {
  it("AC4: put, putWrites and list take LangGraph's parameters, newVersions included", () => {
    expectTypeOf<Parameters<MongoCheckpointSaver["put"]>>().toEqualTypeOf<
      Parameters<BaseCheckpointSaver["put"]>
    >();
    expectTypeOf<Parameters<MongoCheckpointSaver["list"]>>().toEqualTypeOf<
      Parameters<BaseCheckpointSaver["list"]>
    >();
    expectTypeOf<Parameters<MongoCheckpointSaver["putWrites"]>>().toExtend<
      Parameters<BaseCheckpointSaver["putWrites"]>
    >();
    expect(new MongoCheckpointSaver(connectionTo(database.url()))).toBeInstanceOf(
      BaseCheckpointSaver,
    );
  });

  it("AC4: a put given LangGraph's newVersions keeps the checkpoint's channel versions, the new ones laid over", async () => {
    const saver = new MongoCheckpointSaver(connectionTo(database.url()));
    const checkpoint = {
      ...emptyCheckpoint(),
      id: "1ef-891",
      channel_versions: { messages: 2, __start__: 1 },
    };
    const newVersions: ChannelVersions = { messages: 2, answer: 1 };

    const saved = await saver.put(
      { configurable: { thread_id: "thread-891", checkpoint_ns: "" } },
      checkpoint,
      { source: "loop", step: 1, parents: {} },
      newVersions,
    );
    const tuple = await saver.getTuple(saved);

    expect(tuple?.checkpoint.channel_versions).toEqual({ messages: 2, __start__: 1, answer: 1 });
    expect(tuple?.metadata).toEqual({ source: "loop", step: 1, parents: {} });
  });
});
