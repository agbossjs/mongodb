import type { PendingWrite } from "@langchain/langgraph-checkpoint";
import { Binary, type AnyBulkWriteOperation } from "mongodb";
import { idOf } from "../keys.js";
import { writeIndexOf, type WriteDocument } from "./checkpoint-documents.js";

/** What `serde` dumps a value as. */
interface Serde {
  dumpsTyped(value: unknown): Promise<[string, Uint8Array]>;
}

/** Where the writes go: a checkpoint of a thread and namespace, with its tenant. */
interface WriteKey {
  readonly tenantId: string;
  readonly threadId: string;
  readonly namespace: string;
  readonly checkpointId: string;
}

/**
 * The upserts of a task's `writes` of one `putWrites` call (`seq`): a regular write is kept as first
 * written, a special one (an error, an interrupt) replaces its own.
 */
export const writeOperationsOf = (
  serde: Serde,
  key: WriteKey,
  taskId: string,
  seq: number,
  writes: readonly PendingWrite[],
): Promise<AnyBulkWriteOperation<WriteDocument>[]> =>
  Promise.all(
    writes.map(
      async ([channel, value], position): Promise<AnyBulkWriteOperation<WriteDocument>> => {
        const [valueType, bytes] = await serde.dumpsTyped(value);
        const index = writeIndexOf(channel, position);
        const placed = { ...key, taskId, index, seq, position };
        const written = { channel, valueType, value: new Binary(bytes) };
        const filter = { _id: idOf(key.threadId, key.namespace, key.checkpointId, taskId, index) };
        const update =
          index >= 0
            ? { $setOnInsert: { ...placed, ...written } }
            : { $set: written, $setOnInsert: placed };
        return { updateOne: { filter, update, upsert: true } };
      },
    ),
  );
