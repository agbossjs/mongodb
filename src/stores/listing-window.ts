import type { Page, PageQuery } from "@agboss/core/stores";

/**
 * The window of a `PageQuery` a store that pages by position reads (agbossjs/agboss#1321b): the
 * cursor is the position a page ended at, opaque to a caller — only one an earlier `nextCursor` gave
 * is read; any other text is refused. The same rule as the core's stores.
 */

/** How many items one page holds when the query names no limit. */
const DEFAULT_PAGE_LIMIT = 100;

/** Where a page starts and how many items it holds. */
export interface ListingWindow {
  readonly offset: number;
  readonly limit: number;
}

/** The window of `query`; a cursor that is not a position a page gave is an error, never a guess. */
export function listingWindowOf(query: PageQuery): ListingWindow {
  const { cursor, limit = DEFAULT_PAGE_LIMIT } = query;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError("a page's limit is a positive whole number");
  if (cursor === undefined) return { offset: 0, limit };
  const offset = /^[0-9]{1,15}$/u.test(cursor) ? Number(cursor) : Number.NaN;
  if (!Number.isSafeInteger(offset)) throw new RangeError("the cursor is not one a listing gave");
  return { offset, limit };
}

/** The page of `window` from the items read at its offset, one more than its limit at most. */
export function pageOfWindow<TItem>(items: readonly TItem[], window: ListingWindow): Page<TItem> {
  const shown = items.slice(0, window.limit);
  return items.length > window.limit
    ? { items: shown, nextCursor: String(window.offset + window.limit) }
    : { items: shown };
}
