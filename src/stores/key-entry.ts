import {
  assertBusinessKey,
  assertEffectName,
  effectKeyIdentityOf,
  fingerprintErrorOf,
  type EffectKey,
  type EffectKeyFields,
} from "@agboss/core/stores";
import { idOf } from "./keys.js";

/**
 * The `_id` a row of `key` has under the PREVIOUS idempotency secret's digest of its business key
 * (agbossjs/agboss#1317d, a rotation): a store looks a row up by the key's, then by this one, and
 * keeps writing under the key's. `undefined` where the key names no business key or no previous one.
 */
export function previousIdOf(key: EffectKey): string | undefined {
  if (key.businessKey === undefined || key.previousBusinessKey === undefined) return undefined;
  const previous = { ...(key as EffectKeyFields), businessKey: key.previousBusinessKey };
  return idOf(effectKeyIdentityOf(previous as EffectKey));
}

/**
 * A key checked at a fencing store's entry, before any command (agbossjs/agboss#508, #538, #825):
 * its name, its business key's text, and under a business key its fingerprint decision — each the
 * core's own error, naming the rule, never the key.
 */
export function assertKeyAtEntry(key: EffectKey): void {
  assertEffectName(key.name);
  assertBusinessKey(key);
  const unfingerprinted = fingerprintErrorOf(key);
  if (unfingerprinted !== undefined) throw unfingerprinted;
}
