import {
  assertBusinessKey,
  assertEffectName,
  fingerprintErrorOf,
  type EffectKey,
} from "@agboss/core";

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
