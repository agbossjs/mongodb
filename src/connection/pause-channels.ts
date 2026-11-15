import type { Db } from "mongodb";
import { z } from "zod";
import { Collections } from "./collections.js";
import { parsedOrUnreadable } from "../stores/unreadable.js";

const Record = z.object({ record: z.string() });
const Channel = z.object({ channel: z.string() });

/**
 * Migration 2 (#938): a pause written under schema 1 has no `channel` field (the tenant's pages
 * filter on it), so it is set from the pause's `record` JSON. A cursor over the documents that lack
 * it, one `updateOne` each — idempotent, and two concurrent runs write the same value. `signal`
 * stops it between documents; the version is raised only after it, so a stopped run is run again.
 */
export async function fillPauseChannels(db: Db, signal?: AbortSignal): Promise<void> {
  const pauses = db.collection(Collections.Pauses);
  const cursor = pauses.find({ channel: { $exists: false } }, { projection: { record: 1 } });
  for await (const found of cursor) {
    signal?.throwIfAborted();
    const { channel } = Channel.parse(parsedOrUnreadable("pause", Record.parse(found).record, {}));
    await pauses.updateOne({ _id: found._id, channel: { $exists: false } }, { $set: { channel } });
  }
}
