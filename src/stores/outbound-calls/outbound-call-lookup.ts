import { effectKeyIdentityOf, type EffectKey } from "@agboss/core/stores";
import type { ClientSession, Collection } from "mongodb";
import { previousIdOf } from "../key-entry.js";
import { idOf } from "../keys.js";
import type { OutboundCallDocument } from "./outbound-call-documents.js";

/**
 * The document of `key`: by its step, or by its tenant, name and business key — and after a
 * rotation of the idempotency secret (agbossjs/agboss#1317d) by the digest the previous secret made
 * of that business key. `null` when there is none.
 */
export async function foundOf(
  calls: Collection<OutboundCallDocument>,
  key: EffectKey,
  session: ClientSession,
): Promise<OutboundCallDocument | null> {
  const found = await calls.findOne({ _id: idOf(effectKeyIdentityOf(key)) }, { session });
  const previous = previousIdOf(key);
  return found !== null || previous === undefined
    ? found
    : calls.findOne({ _id: previous }, { session });
}
