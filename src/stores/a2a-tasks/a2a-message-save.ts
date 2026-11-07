import type { A2AMessageRecord } from "@agboss/core";
import type { Collection } from "mongodb";
import { messageDocumentOf, messageOf, type A2AMessageDocument } from "./a2a-task-documents.js";

/** How often a message whose conflicting document vanished before it was read is upserted again. */
const UPSERT_ATTEMPTS = 2;

/**
 * Upserts `message` (`$setOnInsert`), or reads the one kept under its `_id`: `undefined` when this
 * call saved it (agbossjs/agboss#824). A conflicting document the retention sweep removed before it
 * was read is upserted again; never `undefined` for a message that is not stored.
 */
export async function savedOrKept(
  messages: Collection<A2AMessageDocument>,
  message: A2AMessageRecord,
): Promise<A2AMessageRecord | undefined> {
  const document = messageDocumentOf(message);
  for (let attempt = 1; attempt <= UPSERT_ATTEMPTS; attempt += 1) {
    const saved = await messages.updateOne(
      { _id: document._id },
      { $setOnInsert: document },
      { upsert: true },
    );
    if (saved.upsertedCount === 1) return undefined;
    const kept = await messages.findOne({ _id: document._id });
    if (kept !== null) return messageOf(kept);
  }
  throw new Error("an A2A message's document conflicted, then was gone, twice: nothing is saved");
}
