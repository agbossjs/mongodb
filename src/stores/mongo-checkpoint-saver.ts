import { Injectable } from "@agboss/core";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  copyCheckpoint,
  type CheckpointTuple,
} from "@langchain/langgraph-checkpoint";
import { Binary, type AnyBulkWriteOperation, type Collection } from "mongodb";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import {
  checkpointOf,
  configOf,
  keyOf,
  listFilterOf,
  matchesMetadata,
  metadataOf,
  StoredCheckpoint,
  StoredWrite,
  writeIndexOf,
  type Checkpoint,
  type CheckpointDocument,
  type CheckpointMetadata,
  type ListOptions,
  type PendingWrites,
  type PutWritesArguments,
  type WriteDocument,
} from "./checkpoints/checkpoint-documents.js";
import { idOf } from "./keys.js";
import { nextSequence } from "./sequence.js";

/**
 * LangGraph's `BaseCheckpointSaver` on MongoDB (#265 S32, agbossjs/agboss#527): checkpoints and
 * pending writes, serialized by `this.serde`, each tagged with its run's tenant (#261), in the
 * stores' database on the instance's client. `put` is one replace (upsert) of the checkpoint's
 * document; `putWrites` writes a task's writes in one transaction — a regular write kept as first
 * written, a special one (an error, an interrupt) replacing its own —, in the order given (`seq`
 * of the call, then the write's place). Listed in `@Application({ providers })` with
 * `MongoPausedExecutionRepository`, a pause survives a restart and is resumed on any instance;
 * recovery continues a `running` tree from its last checkpoint.
 */
@Injectable({ deps: [MongoConnection] })
export class MongoCheckpointSaver extends BaseCheckpointSaver {
  constructor(private readonly connection: MongoConnection) {
    super();
  }

  get #checkpoints(): Collection<CheckpointDocument> {
    return this.connection.db.collection<CheckpointDocument>(Collections.Checkpoints);
  }

  get #writes(): Collection<WriteDocument> {
    return this.connection.db.collection<WriteDocument>(Collections.CheckpointWrites);
  }

  /** One `ping` (#300): what `app.checkReadiness()` asks of the checkpoint saver. */
  ping(): Promise<void> {
    return this.connection.ping();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { threadId, namespace, checkpointId } = keyOf(config, "getTuple");
    const found = await this.#checkpoints.findOne(
      { threadId, namespace, ...(checkpointId === undefined ? {} : { checkpointId }) },
      { sort: { checkpointId: -1 } },
    );
    return found === null ? undefined : this.#tupleOf(StoredCheckpoint.parse(found));
  }

  async *list(config: RunnableConfig, options: ListOptions = {}): AsyncGenerator<CheckpointTuple> {
    const cursor = this.#checkpoints.find(listFilterOf(config, options)).sort({ checkpointId: -1 });
    let left = options.limit ?? Number.POSITIVE_INFINITY;
    for await (const found of cursor) {
      if (left <= 0) break;
      const tuple = await this.#tupleOf(StoredCheckpoint.parse(found));
      if (!matchesMetadata(tuple, options)) continue;
      left -= 1;
      yield tuple;
    }
    await cursor.close();
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const { tenantId, threadId, namespace, checkpointId: parentId } = keyOf(config, "put");
    const [[checkpointType, dumped], [metadataType, dumpedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
      this.serde.dumpsTyped(metadata),
    ]);
    const _id = idOf(threadId, namespace, checkpoint.id);
    await this.#checkpoints.replaceOne(
      { _id },
      {
        ...{ tenantId, threadId, namespace, checkpointId: checkpoint.id },
        parentCheckpointId: parentId ?? null,
        ...{ checkpointType, checkpoint: new Binary(dumped) },
        ...{ metadataType, metadata: new Binary(dumpedMetadata) },
      },
      { upsert: true },
    );
    return configOf(threadId, namespace, checkpoint.id);
  }

  async putWrites(...[config, writes, taskId]: PutWritesArguments): Promise<void> {
    const { tenantId, threadId, namespace, checkpointId } = keyOf(config, "putWrites");
    if (checkpointId === undefined)
      throw new Error("MongoCheckpointSaver.putWrites: the config has no checkpoint_id");
    if (writes.length === 0) return;
    const seq = await nextSequence(this.connection.db, Collections.CheckpointWrites);
    const operations = await Promise.all(
      writes.map(
        async ([channel, value], position): Promise<AnyBulkWriteOperation<WriteDocument>> => {
          const [valueType, bytes] = await this.serde.dumpsTyped(value);
          const index = writeIndexOf(channel, position);
          const placed = {
            tenantId,
            threadId,
            namespace,
            checkpointId,
            taskId,
            index,
            seq,
            position,
          };
          const written = { channel, valueType, value: new Binary(bytes) };
          const filter = { _id: idOf(threadId, namespace, checkpointId, taskId, index) };
          // a regular write is kept as first written; a special one (an error, …) replaces its own
          const update =
            index >= 0
              ? { $setOnInsert: { ...placed, ...written } }
              : { $set: written, $setOnInsert: placed };
          return { updateOne: { filter, update, upsert: true } };
        },
      ),
    );
    await this.connection.inTransaction(async ({ session }) => {
      await this.#writes.bulkWrite(operations, { session, ordered: true });
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.connection.inTransaction(async ({ session }) => {
      await this.#writes.deleteMany({ threadId }, { session });
      await this.#checkpoints.deleteMany({ threadId }, { session });
    });
  }

  async #tupleOf(stored: StoredCheckpoint): Promise<CheckpointTuple> {
    const checkpoint = checkpointOf(
      await this.serde.loadsTyped(stored.checkpointType, stored.checkpoint),
    );
    const metadata = metadataOf(await this.serde.loadsTyped(stored.metadataType, stored.metadata));
    const tuple: CheckpointTuple = {
      config: configOf(stored.threadId, stored.namespace, stored.checkpointId),
      checkpoint,
      metadata,
      pendingWrites: await this.#pendingWritesOf(stored),
    };
    return stored.parentCheckpointId === null
      ? tuple
      : {
          ...tuple,
          parentConfig: configOf(stored.threadId, stored.namespace, stored.parentCheckpointId),
        };
  }

  async #pendingWritesOf(stored: StoredCheckpoint): Promise<PendingWrites> {
    const { threadId, namespace, checkpointId } = stored;
    const found = await this.#writes
      .find({ threadId, namespace, checkpointId })
      .sort({ seq: 1, position: 1 })
      .toArray();
    return Promise.all(
      found.map(async (one): Promise<PendingWrites[number]> => {
        const write = StoredWrite.parse(one);
        return [
          write.taskId,
          write.channel,
          await this.serde.loadsTyped(write.valueType, write.value),
        ];
      }),
    );
  }
}
