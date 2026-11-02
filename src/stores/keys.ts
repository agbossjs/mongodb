/**
 * The `_id` of a document keyed by several texts: their JSON array. One text per key whatever the
 * texts hold — a separator in a tenant id cannot make two keys one — and `JSON.stringify` escapes a
 * lone surrogate (`\ud83e`), which the driver would otherwise write as U+FFFD, so two such keys are
 * never one document either. Compared byte for byte (the simple collation).
 */
export const idOf = (...parts: readonly (string | number)[]): string => JSON.stringify(parts);

/** The `_id` of a tree's documents: its tenant and its root execution. */
export const treeIdOf = (tenantId: string, rootExecutionId: string): string =>
  idOf(tenantId, rootExecutionId);

/** The MongoDB error code of a duplicate key (`E11000`). */
export const DUPLICATE_KEY = 11000;

/** Whether `error` is a server error with `code`. */
export const hasCode = (error: unknown, code: number): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;
