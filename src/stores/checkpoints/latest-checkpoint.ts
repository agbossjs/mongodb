import type { Collection } from "mongodb";
import {
  metadataOf,
  stepOf,
  StoredMetadata,
  type CheckpointDocument,
} from "./checkpoint-documents.js";

/** What `serde` loads a stored value with. */
interface Serde {
  loadsTyped(type: string, data: Uint8Array): Promise<unknown>;
}

/** A thread's namespace. */
interface Place {
  readonly threadId: string;
  readonly namespace: string;
}

/**
 * The checkpoint document of `place` newest by `(step, id)` (agbossjs/agboss#962): one sorted
 * `findOne` on the `latest_by_step` index, ids by byte (the simple collation). A checkpoint written
 * before the index has no `step`: those of `place`, if any, are given theirs first (one indexed look
 * finds none after that).
 */
export async function latestDocumentOf(
  checkpoints: Collection<CheckpointDocument>,
  serde: Serde,
  { threadId, namespace }: Place,
): Promise<CheckpointDocument | null> {
  await stepMissing(checkpoints, serde, { threadId, namespace });
  return checkpoints.findOne({ threadId, namespace }, { sort: { step: -1, checkpointId: -1 } });
}

/** Gives each checkpoint of `place` without a `step` the one its metadata names. */
async function stepMissing(
  checkpoints: Collection<CheckpointDocument>,
  serde: Serde,
  place: Place,
): Promise<void> {
  const unstepped = await checkpoints
    .find({ ...place, step: { $exists: false } })
    .project({ metadataType: 1, metadata: 1 })
    .toArray();
  if (unstepped.length === 0) return;
  const updates = await Promise.all(
    unstepped.map(async (one) => {
      const stored = StoredMetadata.parse(one);
      const metadata = metadataOf(await serde.loadsTyped(stored.metadataType, stored.metadata));
      // only a document still without a step: a concurrent put's own step is never overwritten
      return {
        updateOne: {
          filter: { _id: stored._id, step: { $exists: false } },
          update: { $set: { step: stepOf(metadata) } },
        },
      };
    }),
  );
  await checkpoints.bulkWrite(updates, { ordered: false });
}
