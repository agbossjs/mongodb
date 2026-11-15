import { parsedStoredJson } from "@agboss/core/stores";

/**
 * The text as JSON (#906 D4, #1121, #1166): a text that is not JSON is refused as a record that fails
 * its schema is, with `StoredNamesUnreadableError` naming `what` and the store's own keys of the row,
 * never the text — the core's `parsedStoredJson`.
 */
export function parsedOrUnreadable(
  what: string,
  text: string,
  ids: Readonly<Record<string, string | undefined>>,
  reviver?: (key: string, value: unknown) => unknown,
): unknown {
  return parsedStoredJson(what, text, ids, reviver);
}
