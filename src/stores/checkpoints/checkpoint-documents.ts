import type { RunnableConfig } from "@langchain/core/runnables";
import {
  WRITES_IDX_MAP,
  type BaseCheckpointSaver,
  type CheckpointTuple,
} from "@langchain/langgraph-checkpoint";
import { Binary, type Filter } from "mongodb";
import { z } from "zod";

/**
 * The documents of `MongoCheckpointSaver` (#265 S32, agbossjs/agboss#527): `agboss_checkpoints`
 * (one per checkpoint of a thread and namespace, the parent's id kept) and
 * `agboss_checkpoint_writes` (a task's pending writes of one checkpoint), the values as the saver's
 * `serde` dumps them with their type, as BSON binary. A checkpoint's place among its thread's is
 * LangGraph's own: its id, compared byte for byte (the core orders a thread written out of order
 * itself, agbossjs/agboss#682).
 */

export type PutWritesArguments = Parameters<BaseCheckpointSaver["putWrites"]>;
export type Checkpoint = Parameters<BaseCheckpointSaver["put"]>[1];
export type CheckpointMetadata = Parameters<BaseCheckpointSaver["put"]>[2];
export type ListOptions = NonNullable<Parameters<BaseCheckpointSaver["list"]>[1]>;
export type PendingWrites = NonNullable<CheckpointTuple["pendingWrites"]>;

export interface CheckpointDocument {
  _id: string;
  tenantId: string;
  threadId: string;
  namespace: string;
  checkpointId: string;
  parentCheckpointId: string | null;
  checkpointType: string;
  checkpoint: Binary;
  metadataType: string;
  metadata: Binary;
}

export interface WriteDocument {
  _id: string;
  tenantId: string;
  threadId: string;
  namespace: string;
  checkpointId: string;
  taskId: string;
  index: number;
  /** The `putWrites` call's number in the writes' sequence, then the write's place in it. */
  seq: number;
  position: number;
  channel: string;
  valueType: string;
  value: Binary;
}

const Bytes = z.instanceof(Binary).transform((binary) => new Uint8Array(binary.buffer));

export const StoredCheckpoint = z.object({
  threadId: z.string(),
  namespace: z.string(),
  checkpointId: z.string(),
  parentCheckpointId: z.string().nullable(),
  checkpointType: z.string(),
  checkpoint: Bytes,
  metadataType: z.string(),
  metadata: Bytes,
});
export type StoredCheckpoint = z.infer<typeof StoredCheckpoint>;

export const StoredWrite = z.object({
  taskId: z.string(),
  channel: z.string(),
  valueType: z.string(),
  value: Bytes,
});

/** Where a checkpoint is: its tenant (#261), thread, namespace and (absent = the latest) id. */
export interface CheckpointKey {
  readonly tenantId: string;
  readonly threadId: string;
  readonly namespace: string;
  readonly checkpointId: string | undefined;
}

const Configurable = z.object({
  tenant_id: z.string().min(1).optional(),
  thread_id: z.string().min(1).optional(),
  checkpoint_ns: z.string().optional(),
  checkpoint_id: z.string().min(1).optional(),
});

/** The key a config names; a missing `thread_id` fails, naming the field. */
export function keyOf(config: RunnableConfig, operation: string): CheckpointKey {
  const configurable = Configurable.parse(config.configurable ?? {});
  if (configurable.thread_id === undefined)
    throw new Error(
      `MongoCheckpointSaver.${operation}: the config has no configurable.thread_id — every checkpoint belongs to a thread`,
    );
  return {
    tenantId: configurable.tenant_id ?? "default",
    threadId: configurable.thread_id,
    namespace: configurable.checkpoint_ns ?? "",
    checkpointId: configurable.checkpoint_id,
  };
}

/** The filter of `list(config, { before })`: a thread (or every thread), a namespace, an id. */
export function listFilterOf(
  config: RunnableConfig,
  options: ListOptions,
): Filter<CheckpointDocument> {
  const filter = Configurable.parse(config.configurable ?? {});
  const before =
    options.before === undefined
      ? undefined
      : Configurable.parse(options.before.configurable ?? {});
  const ids = {
    ...(filter.checkpoint_id === undefined ? {} : { $eq: filter.checkpoint_id }),
    ...(before?.checkpoint_id === undefined ? {} : { $lt: before.checkpoint_id }),
  };
  return {
    ...(filter.thread_id === undefined ? {} : { threadId: filter.thread_id }),
    ...(filter.checkpoint_ns === undefined ? {} : { namespace: filter.checkpoint_ns }),
    ...(Object.keys(ids).length === 0 ? {} : { checkpointId: ids }),
  };
}

/** Whether a checkpoint's metadata has every field `list`'s `filter` asks for. */
export const matchesMetadata = (tuple: CheckpointTuple, options: ListOptions): boolean => {
  const metadata: Readonly<Record<string, unknown>> = tuple.metadata ?? {};
  return Object.entries(options.filter ?? {}).every(([key, value]) => metadata[key] === value);
};

const LoadedCheckpoint = z.looseObject({
  v: z.number(),
  id: z.string(),
  ts: z.string(),
  channel_values: z.record(z.string(), z.unknown()),
  channel_versions: z.record(z.string(), z.union([z.number(), z.string()])),
  versions_seen: z.record(z.string(), z.record(z.string(), z.union([z.number(), z.string()]))),
});

const isCheckpoint = (value: unknown): value is Checkpoint =>
  LoadedCheckpoint.safeParse(value).success;

/** A loaded checkpoint, checked: what `put` dumped. */
export function checkpointOf(loaded: unknown): Checkpoint {
  if (!isCheckpoint(loaded))
    throw new Error("MongoCheckpointSaver: a stored checkpoint is not readable");
  return loaded;
}

const isMetadata = (value: unknown): value is CheckpointMetadata =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Loaded metadata, checked: an object. */
export function metadataOf(loaded: unknown): CheckpointMetadata {
  if (!isMetadata(loaded)) throw new Error("MongoCheckpointSaver: stored metadata is not readable");
  return loaded;
}

/** The config that names one stored checkpoint. */
export const configOf = (
  threadId: string,
  namespace: string,
  checkpointId: string,
): RunnableConfig => ({
  configurable: { thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: checkpointId },
});

/** The index of the `position`-th write of a task to `channel` (special channels: LangGraph's map). */
export const writeIndexOf = (channel: string, position: number): number =>
  WRITES_IDX_MAP[channel] ?? position;
