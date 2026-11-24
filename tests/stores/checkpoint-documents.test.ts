/**
 * agbossjs/mongodb#104: how the checkpoint saver reads a config and a stored document, on values
 * given by hand (no server): the step a checkpoint is ordered by, the key and the filter a config
 * names, what a loaded checkpoint and its metadata must be to be read.
 */
import {
  emptyCheckpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";
import {
  checkpointOf,
  configOf,
  keyOf,
  listFilterOf,
  matchesMetadata,
  metadataOf,
  stepOf,
  writeIndexOf,
} from "../../src/stores/checkpoints/checkpoint-documents.js";

const configurable = (fields: Record<string, unknown>) => ({ configurable: fields });

describe("stepOf: the step a checkpoint is ordered by", () => {
  it.each([
    [{ step: 3 }, 3],
    [{ step: 0 }, 0],
    [{ step: -1 }, -1],
    [{ step: 1.5 }, 1.5],
  ])("%o is %i", (metadata, step) => {
    expect(stepOf(metadata)).toBe(step);
  });

  it.each([
    ["no metadata", undefined],
    ["no step", {}],
    ["a step that is a text", { step: "3" }],
    ["a step that is NaN", { step: Number.NaN }],
    ["a step that is infinite", { step: Number.POSITIVE_INFINITY }],
    ["a step that is null", { step: null }],
  ])("%s is -2", (_name, metadata) => {
    expect(stepOf(metadata)).toBe(-2);
  });
});

describe("keyOf: the key a config names", () => {
  it("tenant, thread, namespace and checkpoint id, as given", () => {
    expect(
      keyOf(
        configurable({
          tenant_id: "acme",
          thread_id: "thread-1",
          checkpoint_ns: "sub",
          checkpoint_id: "c-1",
        }),
        "get",
      ),
    ).toEqual({
      tenantId: "acme",
      threadId: "thread-1",
      rootId: "thread-1",
      namespace: "sub",
      checkpointId: "c-1",
    });
  });

  it("a thread alone: the default tenant, the empty namespace, no checkpoint", () => {
    expect(keyOf(configurable({ thread_id: "t" }), "get")).toStrictEqual({
      tenantId: "default",
      threadId: "t",
      rootId: "t",
      namespace: "",
      checkpointId: undefined,
    });
  });

  it("a tree's root is the one the config names; none named is the thread itself, never read from the shape of its id", () => {
    expect(
      keyOf(configurable({ thread_id: "root/child/a", root_execution_id: "root" }), "get").rootId,
    ).toBe("root");
    expect(keyOf(configurable({ thread_id: "root/child/a" }), "get").rootId).toBe("root/child/a");
    expect(() => keyOf(configurable({ thread_id: "t", root_execution_id: "" }), "get")).toThrow();
  });

  it("an empty namespace is a namespace, and an empty tenant, thread or checkpoint id is refused", () => {
    expect(keyOf(configurable({ thread_id: "t", checkpoint_ns: "" }), "get").namespace).toBe("");
    for (const field of ["tenant_id", "thread_id", "checkpoint_id"])
      expect(() => keyOf(configurable({ thread_id: "t", [field]: "" }), "get")).toThrow();
  });

  it.each(["getTuple", "latestByStep", "put", "putWrites"])(
    "no thread: %s says it, and why",
    (operation) => {
      expect(() => keyOf(configurable({}), operation)).toThrow(
        `MongoCheckpointSaver.${operation}: the config has no configurable.thread_id — every checkpoint belongs to a thread`,
      );
      expect(() => keyOf({}, operation)).toThrow(`MongoCheckpointSaver.${operation}:`);
    },
  );
});

describe("listFilterOf: the filter of a list", () => {
  it("nothing named: every checkpoint of every thread", () => {
    expect(listFilterOf({}, {})).toStrictEqual({});
  });

  it("a thread, a namespace (the empty one too), a checkpoint id", () => {
    expect(listFilterOf(configurable({ thread_id: "t" }), {})).toStrictEqual({ threadId: "t" });
    expect(listFilterOf(configurable({ checkpoint_ns: "" }), {})).toStrictEqual({ namespace: "" });
    expect(listFilterOf(configurable({ checkpoint_id: "c-1" }), {})).toStrictEqual({
      checkpointId: { $eq: "c-1" },
    });
  });

  it("`before` is the ids below it, and with a checkpoint id of the config, both", () => {
    const before = configurable({ checkpoint_id: "c-9" });

    expect(listFilterOf(configurable({ thread_id: "t" }), { before })).toStrictEqual({
      threadId: "t",
      checkpointId: { $lt: "c-9" },
    });
    expect(
      listFilterOf(configurable({ thread_id: "t", checkpoint_id: "c-1" }), { before }),
    ).toStrictEqual({ threadId: "t", checkpointId: { $eq: "c-1", $lt: "c-9" } });
  });

  it("a `before` that names no checkpoint adds nothing", () => {
    expect(listFilterOf(configurable({ thread_id: "t" }), { before: {} })).toStrictEqual({
      threadId: "t",
    });
  });
});

describe("matchesMetadata: a list's metadata filter", () => {
  const meta = { source: "loop", step: 1, parents: {} } satisfies CheckpointMetadata;
  const tuple = (metadata: CheckpointMetadata | undefined): CheckpointTuple => ({
    config: {},
    checkpoint: { ...emptyCheckpoint(), id: "c" },
    metadata,
  });

  it("no filter matches everything, and every field of a filter must match", () => {
    expect(matchesMetadata(tuple(meta), {})).toBe(true);
    expect(matchesMetadata(tuple(meta), { filter: { step: 1 } })).toBe(true);
    expect(matchesMetadata(tuple(meta), { filter: { step: 1, source: "loop" } })).toBe(true);
    expect(matchesMetadata(tuple(meta), { filter: { step: 1, source: "input" } })).toBe(false);
    expect(matchesMetadata(tuple(meta), { filter: { other: 1 } })).toBe(false);
  });

  it("a checkpoint with no metadata matches an empty filter only", () => {
    expect(matchesMetadata(tuple(undefined), { filter: {} })).toBe(true);
    expect(matchesMetadata(tuple(undefined), { filter: { step: 1 } })).toBe(false);
  });
});

describe("checkpointOf: a loaded checkpoint is what `put` dumped, or it is refused", () => {
  const valid = {
    v: 1,
    id: "c-1",
    ts: "2026-01-05T09:00:00.000Z",
    channel_values: { messages: ["hi"] },
    channel_versions: { messages: 2, other: "00000000000000000000000000000002.123" },
    versions_seen: { node: { messages: 1, other: "0001.5" } },
  };

  it("a valid one is returned as it is, with the fields this reading does not know", () => {
    const loaded = { ...valid, pending_sends: [1] };

    expect(checkpointOf(loaded)).toBe(loaded);
  });

  it.each([
    ["no version", { ...valid, v: undefined }],
    ["a version that is a text", { ...valid, v: "1" }],
    ["no id", { ...valid, id: undefined }],
    ["an id that is a number", { ...valid, id: 1 }],
    ["a time that is a number", { ...valid, ts: 1 }],
    ["channel values that are a list", { ...valid, channel_values: [] }],
    ["channel values that are none", { ...valid, channel_values: undefined }],
    ["a channel version that is a flag", { ...valid, channel_versions: { a: true } }],
    ["channel versions that are none", { ...valid, channel_versions: undefined }],
    ["versions seen that are a flat map", { ...valid, versions_seen: { node: 1 } }],
    ["a version seen that is a flag", { ...valid, versions_seen: { node: { a: false } } }],
    ["versions seen that are none", { ...valid, versions_seen: undefined }],
    ["nothing", undefined],
    ["a text", "checkpoint"],
    ["null", null],
  ])("%s is refused", (_name, loaded) => {
    expect(() => checkpointOf(loaded)).toThrow(
      "MongoCheckpointSaver: a stored checkpoint is not readable",
    );
  });
});

describe("metadataOf: loaded metadata is an object", () => {
  it("an object, an empty one too, is returned as it is", () => {
    const loaded = { source: "loop", step: 1 };

    expect(metadataOf(loaded)).toBe(loaded);
    expect(metadataOf({})).toEqual({});
  });

  it.each([null, undefined, [], [1], "meta", 3, true])("%j is refused", (loaded) => {
    expect(() => metadataOf(loaded)).toThrow(
      "MongoCheckpointSaver: stored metadata is not readable",
    );
  });
});

describe("configOf and writeIndexOf", () => {
  it("a config names thread, namespace and checkpoint", () => {
    expect(configOf("t", "ns", "c")).toStrictEqual({
      configurable: { thread_id: "t", checkpoint_ns: "ns", checkpoint_id: "c" },
    });
  });

  it("a write's index is LangGraph's for a special channel, its place for any other", () => {
    expect(writeIndexOf("some-channel", 4)).toBe(4);
    expect(writeIndexOf("__error__", 4)).toBeLessThan(0);
  });
});
