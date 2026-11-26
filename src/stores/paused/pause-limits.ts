/**
 * Whether a deadline a change sets keeps the cap (restated from the core's `isWithinCap`, which the
 * stores entry does not export): with a `maxExpiresAt`, only a deadline at or before it does — none
 * at all is past any cap. Both are ISO 8601 texts of `toISOString()`: they compare as instants. The
 * store judges it atomically with the write, over the cap its own record holds (narrowed by a move).
 */
export const isWithinCap = (
  maxExpiresAt: string | undefined,
  expiresAt: string | undefined,
): boolean => maxExpiresAt === undefined || (expiresAt !== undefined && expiresAt <= maxExpiresAt);
