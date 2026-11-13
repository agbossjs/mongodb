import type { z } from "zod";

/** ` (threadId t, runId r)`, or nothing when no id is known. */
const named = (ids: string): string => (ids === "" ? "" : ` (${ids})`);

/** The ids that name a stored value in an error: its keys, never its content. */
const idsOf = (value: unknown, keys: readonly string[]): string =>
  keys
    .flatMap((key) => {
      const id: unknown =
        typeof value === "object" && value !== null ? Reflect.get(value, key) : "";
      return typeof id === "string" ? [`${key} ${id}`] : [];
    })
    .join(", ");

/**
 * Why a stored value is refused (#906 D4): what it should have been, the ids that name it and the
 * field that failed — never the value, whose input and data are the caller's (PII reaches the logs
 * through a message). The schema's own error, which names paths and expectations only, is the `cause`.
 */
export function unreadable(
  what: string,
  keys: readonly string[],
  value: unknown,
  failure: { readonly error?: z.ZodError; readonly field?: string },
): Error {
  const field =
    failure.field ??
    [
      ...new Set(
        (failure.error?.issues ?? []).map((issue) => issue.path.join(".") || "(the value)"),
      ),
    ].join(", ");
  return new Error(
    `a stored ${what} is not readable${named(idsOf(value, keys))}: the field(s) ${field === "" ? "(the value)" : field} missing or not what the framework wrote`,
    { cause: failure.error },
  );
}

/**
 * The text as JSON. A parser's message quotes the text it failed on (`startInput`, PII, #906 D4):
 * a failure is refused by name, `ids` the store's own keys of the row, with neither the text nor
 * the parser's message, and no cause.
 */
export function parsedOrUnreadable(
  what: string,
  text: string,
  ids: Readonly<Record<string, string | undefined>>,
  reviver?: (key: string, value: unknown) => unknown,
): unknown {
  try {
    return JSON.parse(text, reviver);
  } catch {
    const parts = Object.entries(ids).flatMap(([key, id]) =>
      id === undefined ? [] : [`${key} ${id}`],
    );
    throw new Error(
      `a stored ${what} is not readable${named(parts.join(", "))}: the text is not valid JSON`,
    );
  }
}
