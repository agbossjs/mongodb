/** ` (threadId t, runId r)`, or nothing when no id is known. */
const named = (ids: string): string => (ids === "" ? "" : ` (${ids})`);

/**
 * The text as JSON (#906 D4). A parser's message quotes the text it failed on (`startInput`, the
 * caller's PII): a failure is refused by name — `what` and the store's own keys of the row, `ids`,
 * never a tenant — with neither the text nor the parser's message, and no cause. A text that parses
 * is read by the core's schemas, which name their own ids and fields (`StoredNamesUnreadableError`).
 */
export function parsedOrUnreadable(
  what: string,
  text: string,
  ids: Readonly<Record<string, string | undefined>>,
  reviver?: (key: string, value: unknown) => unknown,
): unknown {
  try {
    return JSON.parse(text, reviver) as unknown;
  } catch {
    const parts = Object.entries(ids).flatMap(([key, id]) =>
      id === undefined ? [] : [`${key} ${id}`],
    );
    throw new Error(
      `a stored ${what} is not readable${named(parts.join(", "))}: the text is not valid JSON`,
    );
  }
}
