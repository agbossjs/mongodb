import {
  fencedKeyIdentityOf,
  FencedEffectStatus,
  replayedFromOf,
  storedKeyFactsOf,
  type FencedEffectKey,
  type FencedEffectOutcome,
} from "@agboss/core";
import { z } from "zod";
import { idOf } from "../keys.js";

/** One stored result: its key's identity, the token it was written under, its JSON as text. */
export interface ResultDocument {
  _id: string;
  token: number;
  result: string;
  storedAt: Date;
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
export function replayOf<TResult>(
  key: FencedEffectKey,
  found: unknown,
): FencedEffectOutcome<TResult> {
  const stored = StoredResult.parse(found);
  const replayedFrom = replayedFromOf(key, {
    fingerprint: stored.fingerprint ?? null,
    origin: stored.origin ?? null,
  });
  return {
    status: FencedEffectStatus.Replayed,
    // written by this store as the JSON of the work's result
    result: JSON.parse(stored.result) as TResult,
    token: stored.token,
    ...(replayedFrom === undefined ? {} : { replayedFrom }),
  };
}

/** The document `key`'s result is stored as. */
export function resultDocumentOf(key: FencedEffectKey, text: string, now: Date): ResultDocument {
  const stored: ResultDocument = {
    _id: idOf(fencedKeyIdentityOf(key)),
    token: key.token,
    result: text,
    storedAt: now,
  };
  if (key.businessKey === undefined) return stored;
  const { fingerprint, origin } = storedKeyFactsOf(key);
  return {
    ...stored,
    fingerprint: fingerprint ?? null,
    ...(origin === undefined ? {} : { origin }),
  };
}
