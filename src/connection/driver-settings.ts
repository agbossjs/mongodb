import { SchemaSetup, type DriverTimeouts, type ResolvedSettings } from "@agboss/core/stores";
import { z } from "zod";
import { MongoSettingsError } from "../errors.js";
import { MongoTransactionReadConcern } from "./concerns.js";
import type { MongoConnectionSettings } from "./settings.js";

/**
 * The settings `MongoDriver` resolved (agbossjs/agboss#1321f): its options with the `secret(…)` of
 * the URL revealed, the durations in `Milliseconds` (`DriverTimeouts`), read once at start. What
 * `MongoConnection` makes its client of.
 */

/** A `Secret` of the resolved settings: only `reveal()` gives its value. */
const Revealing = z.custom<{ reveal(): string }>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "reveal" in value &&
    typeof value.reveal === "function",
  { message: "the driver's url must be a secret(…)" },
);

const Resolved = z.object({
  kind: z.literal("mongodb"),
  url: Revealing,
  database: z.string().min(1).optional(),
  transactionReadConcern: z.enum(MongoTransactionReadConcern).optional(),
  schemaSetup: z.enum(SchemaSetup).optional(),
  watchLiveness: z.number().optional(),
  commandTimeout: z.number().optional(),
  idleInTransactionTimeout: z.number().optional(),
});

/** What the driver's options `timeouts` hold, as settings fields. */
export const timeoutSettingsOf = (timeouts: DriverTimeouts | undefined): Record<string, number> =>
  Object.fromEntries(
    Object.entries(timeouts ?? {}).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );

/**
 * The connection settings of a driver's resolved settings; `MongoSettingsError` for one that is
 * none, and for a time option this driver has no meaning for (fail closed: never silently ignored).
 */
export function settingsOfResolved(resolved: ResolvedSettings): MongoConnectionSettings {
  const parsed = Resolved.safeParse(resolved);
  if (!parsed.success)
    throw new MongoSettingsError({
      message: `the MongoDB driver's settings are wrong — ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    });
  const { url: secret, watchLiveness, commandTimeout, idleInTransactionTimeout } = parsed.data;
  if (commandTimeout !== undefined || idleInTransactionTimeout !== undefined)
    throw new MongoSettingsError({
      message:
        "the MongoDB driver takes no commandTimeout or idleInTransactionTimeout (PostgreSQL's): its transactions are bounded by the server's transactionLifetimeLimitSeconds",
    });
  const url = secret.reveal();
  if (url.length === 0) throw new MongoSettingsError({ message: "the driver's url is empty" });
  return {
    url,
    ...(parsed.data.database === undefined ? {} : { database: parsed.data.database }),
    ...(parsed.data.transactionReadConcern === undefined
      ? {}
      : { transactionReadConcern: parsed.data.transactionReadConcern }),
    ...(parsed.data.schemaSetup === undefined ? {} : { schemaSetup: parsed.data.schemaSetup }),
    ...(watchLiveness === undefined
      ? {}
      : { watchLivenessSeconds: Math.round(watchLiveness / 1000) }),
  };
}
