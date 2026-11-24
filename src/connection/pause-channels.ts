import type { Db } from "mongodb";
import { z } from "zod";
import { Collections } from "./collections.js";
import { parsedOrUnreadable } from "../stores/unreadable.js";

const Record = z.object({ record: z.string() });
const Channel = z.object({ channel: z.string() });

/**
 * The pauses of `scope` that lack `channel` get it from their record. The migration runs it over
 * every pause; a channel-filtered page runs it over its tenant's before it reads (agbossjs/agboss#1104,
 * as `latestByStep` gives a checkpoint its `step`): an instance of the previous version that is
 * still running after the migration writes pauses with no `channel`, and no later migration would
 * fix them. Idempotent: two runs at once write the same value.
 */
export async function fillMissingChannels(
  db: Db,
  scope: { readonly tenantId?: string },
  signal?: AbortSignal,
): Promise<void> {
  const pauses = db.collection(Collections.Pauses);
  // `null` matches a document without the field, and the tenant's prefix of `by_tenant` serves it
  const lacking = { ...scope, channel: null };
  const cursor = pauses.find(lacking, { projection: { record: 1 } });
  for await (const found of cursor) {
    signal?.throwIfAborted();
    const { channel } = Channel.parse(parsedOrUnreadable("pause", Record.parse(found).record, {}));
    await pauses.updateOne({ _id: found._id, channel: null }, { $set: { channel } });
  }
}
