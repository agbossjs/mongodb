import type { StoreClock } from "@agboss/core";

/**
 * The time a statement decides a lease by (agbossjs/agboss#533): the server's own, `$$NOW` — bound
 * once per command, on the primary that executes it, so every instance agrees on a lease's expiry
 * whatever its own wall clock says —, or, when a test injected its clock (`StoreClock.isDatabaseTime`
 * false), that clock's time as a literal, so the contract suites can move it. Used inside `$expr`
 * filters and update pipelines only: never compared with a client's clock.
 */
export type StoreNow = "$$NOW" | Date;

/** `$$NOW` in production; the test's clock as a date literal otherwise. */
export const storeNowOf = (clock: StoreClock): StoreNow =>
  clock.isDatabaseTime ? "$$NOW" : clock.now();

/**
 * A value as an aggregation literal: a text a caller gave (a holder's id, a tenant) that starts
 * with `$` would otherwise be read as a field path inside a pipeline.
 */
export const literal = <TValue>(value: TValue): { readonly $literal: TValue } => ({
  $literal: value,
});
