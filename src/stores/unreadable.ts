import { StoredNamesUnreadableError } from "@agboss/core/stores";

/**
 * The text as JSON (#906 D4, #1121). A parser's message quotes the text it failed on (`startInput`,
 * the caller's PII): a failure is refused as a record that fails its schema is, with
 * `StoredNamesUnreadableError` (`code: "stored.unreadable"`) naming `what` and the store's own keys
 * of the row, `ids`, never a tenant. The `cause` is a `SyntaxError` of the parse without the text.
 * (The core's `parsedStoredJson` does the same: use it once the pin holds it, #1064.)
 */
export function parsedOrUnreadable(
  what: string,
  text: string,
  ids: Readonly<Record<string, string | undefined>>,
  reviver?: (key: string, value: unknown) => unknown,
): unknown {
  try {
    return JSON.parse(text, reviver) as unknown;
  } catch (error) {
    const position = /at position (\d+)/.exec(error instanceof Error ? error.message : "")?.[1];
    throw new StoredNamesUnreadableError({
      record: what,
      ids: Object.entries(ids)
        .flatMap(([key, id]) => (id === undefined ? [] : [`${key} ${id}`]))
        .join(", "),
      fields: "(the text)",
      cause: new SyntaxError(
        `the text is not valid JSON${position === undefined ? "" : ` (at position ${position})`}`,
      ),
    });
  }
}
