/**
 * The paged listing's arguments, checked at the store's entry (agbossjs/agboss#825): the core's
 * contract case refuses a limit that is no whole number from 1 and a cursor this store never gave.
 */

/** `limit` as asked: a whole number from 1 — `0`, a fraction, `NaN` or a negative one is a `RangeError`. */
export function pageLimitOf(limit: number): number {
  if (Number.isSafeInteger(limit) && limit >= 1) return limit;
  throw new RangeError(`a page's limit is a whole number of calls from 1, got ${String(limit)}`);
}

/** The `seq` a cursor of this store names: a whole number from 1, as it handed it out. */
export function seqOfCursor(cursor: string): number {
  const seq = Number(cursor);
  if (/^[1-9][0-9]*$/u.test(cursor) && Number.isSafeInteger(seq)) return seq;
  throw new RangeError("the cursor is not one this store gave: pass the next of one of its pages");
}
