import { IdempotencyRunStatus, type IdempotencyRunOutcome } from "@agboss/core";
import {
  effectKeyIdentityOf,
  replayedFromOf,
  storedKeyFactsOf,
  type EffectKey,
} from "@agboss/core/stores";
import { z } from "zod";
import { idOf } from "../keys.js";
import { parsedOrUnreadable } from "../unreadable.js";

/** One stored result: its key's identity, the token it was written under, its JSON as text. */
export interface ResultDocument {
  _id: string;
  token: number;
  result: string;
  storedAt: Date;
  /** When the result may be removed (`now + ttl` of the call), `null` for `Ttl.Forever`. */
  expiresAt: Date | null;
  /** A business key's (#508): the fingerprint as given — `""` kept as `""`, none as `null`. */
  fingerprint?: string | null;
  /** A business key's: the step that wrote it. */
  origin?: unknown;
}

const StoredResult = z.object({
  token: z.number().int(),
  result: z.string(),
  fingerprint: z.string().nullable().optional(),
  origin: z.unknown().optional(),
});

/** The replay of a stored document: its result, its token, the step it names (a business key's). */
export function replayOf<TResult>(key: EffectKey, found: unknown): IdempotencyRunOutcome<TResult> {
  const stored = StoredResult.parse(found);
  const replayedFrom = replayedFromOf(key, {
    fingerprint: stored.fingerprint ?? null,
    origin: stored.origin ?? null,
  });
  return {
    status: IdempotencyRunStatus.Replayed,
    // written by this store as the JSON of the work's result
    result: parsedOrUnreadable("fenced effect result", stored.result, {
      name: key.name,
    }) as TResult,
    token: stored.token,
    ...(replayedFrom === undefined ? {} : { replayedFrom }),
  };
}

/** The document `key`'s result is stored as. */
export function resultDocumentOf(key: EffectKey, text: string, now: Date): ResultDocument {
  const stored: ResultDocument = {
    _id: idOf(effectKeyIdentityOf(key)),
    token: key.token,
    result: text,
    storedAt: now,
    expiresAt: key.expiresAt,
  };
  if (key.businessKey === undefined) return stored;
  const { fingerprint, origin } = storedKeyFactsOf(key);
  return {
    ...stored,
    fingerprint: fingerprint ?? null,
    ...(origin === undefined ? {} : { origin }),
  };
}
