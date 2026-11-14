import { SchemaSetup } from "@agboss/core/stores";
import { z } from "zod";
import { MongoSettingsError } from "../errors.js";
import { MongoTransactionReadConcern } from "./concerns.js";

/** The database the stores use when the environment does not set `mongodbDatabase`. */
export const DEFAULT_DATABASE = "agboss";

/**
 * How long a dead change stream connection may go unnoticed (agbossjs/agboss#789) when the
 * environment does not set `mongodbWatchLivenessSeconds`: a ping every half of it, an answer due
 * within the other half.
 */
export const DEFAULT_WATCH_LIVENESS_SECONDS = 10;

/**
 * `seconds` when the child queue's watch can run on it — a whole number of at least 2, as the
 * environment's field is checked —, else `MongoSettingsError` naming `watchLivenessSeconds`
 * (agbossjs/agboss#1029): a settings object a script or a provider builds is trusted no more than
 * the environment.
 */
export function checkedWatchLivenessOf(seconds: number | undefined): number | undefined {
  if (seconds === undefined || (Number.isInteger(seconds) && seconds >= 2)) return seconds;
  throw new MongoSettingsError({
    message: `watchLivenessSeconds must be a whole number of at least 2, got ${String(seconds)}`,
  });
}

/**
 * The database a connection string names (`mongodb://h1,h2/<database>?…`), `undefined` when it
 * names none.
 */
export function databaseOfUrl(url: string): string | undefined {
  const path = /^mongodb(?:\+srv)?:\/\/[^/?]*\/([^?]*)/u.exec(url)?.[1];
  return path === undefined || path === "" ? undefined : decodeURIComponent(path);
}

/** What one application instance's connection is made of. */
export interface MongoConnectionSettings {
  /** The replica set: `mongodb://host1,host2,host3/?replicaSet=rs0` (or `mongodb+srv://…`). */
  readonly url: string;
  /** The database the stores' collections are in (default: the URL's, else `agboss`). */
  readonly database?: string;
  /** The read concern of the stores' transactions (default `snapshot`). */
  readonly transactionReadConcern?: MongoTransactionReadConcern;
  /**
   * The longest a silently dead connection of the child queue's change stream (a half-open TCP
   * connection: no FIN, no RST) goes unnoticed, in seconds (agbossjs/agboss#789; default
   * `DEFAULT_WATCH_LIVENESS_SECONDS`, 10, at least 2): the watch pings the server every half of it
   * and gives the answer the other half, then warns, opens the stream on a new client and wakes
   * once.
   * Another value (0, 1, a negative or a fractional number) is a `MongoSettingsError` at construction
   * (agbossjs/agboss#1029), as in the environment.
   */
  readonly watchLivenessSeconds?: number;
  /**
   * What the start does with the schema (agbossjs/agboss#891): `SchemaSetup.Check` (the default)
   * refuses a database not migrated to this package's version; `SchemaSetup.MigrateOnStart`
   * migrates it first.
   */
  readonly schemaSetup?: SchemaSetup;
}

/** A `Secret` of the environment: only `reveal()` gives its value. */
interface RevealedSecret {
  reveal(): string;
}

const isSecret = (value: unknown): value is RevealedSecret =>
  typeof value === "object" &&
  value !== null &&
  "reveal" in value &&
  typeof value.reveal === "function";

/** The fields the MongoDB stores read from the application's environment. */
const MongoEnvironment = z.object({
  mongodbUrl: z.custom<RevealedSecret>(isSecret, {
    message: 'mongodbUrl must be a Secret: mongodbUrl: secret("MONGODB_URL")',
  }),
  mongodbDatabase: z
    .string({ message: "mongodbDatabase must be a text" })
    .min(1, "mongodbDatabase is empty")
    .optional(),
  mongodbTransactionReadConcern: z
    .enum(MongoTransactionReadConcern, {
      message: "mongodbTransactionReadConcern must be snapshot or majority",
    })
    .optional(),
  mongodbWatchLivenessSeconds: z
    .number({ message: "mongodbWatchLivenessSeconds must be a number" })
    .int("mongodbWatchLivenessSeconds must be a whole number")
    .min(2, "mongodbWatchLivenessSeconds must be at least 2")
    .optional(),
  mongodbSchemaSetup: z
    .enum(SchemaSetup, { message: "mongodbSchemaSetup must be check or migrate-on-start" })
    .optional(),
});

const MISSING_URL =
  'mongodbUrl is missing: declare mongodbUrl!: Secret in the environment contract and set mongodbUrl: secret("MONGODB_URL")';

/**
 * The connection settings an application's environment gives: `mongodbUrl` (required, a
 * `Secret`), `mongodbDatabase`, `mongodbTransactionReadConcern`, `mongodbWatchLivenessSeconds` and
 * `mongodbSchemaSetup` (optional). A missing or
 * mistyped field fails with `MongoSettingsError`, naming it — the URL itself is never printed.
 */
export function settingsOfEnvironment(environment: unknown): MongoConnectionSettings {
  const parsed = MongoEnvironment.safeParse(environment);
  if (!parsed.success) {
    const isUrlMissing = Reflect.get(Object(environment), "mongodbUrl") === undefined;
    const problems = parsed.error.issues.map((issue) =>
      issue.path[0] === "mongodbUrl" && isUrlMissing ? MISSING_URL : issue.message,
    );
    throw new MongoSettingsError({
      message: `the MongoDB stores need their environment fields — ${problems.join("; ")}`,
    });
  }
  const { mongodbUrl, mongodbDatabase, mongodbTransactionReadConcern, mongodbSchemaSetup } =
    parsed.data;
  const { mongodbWatchLivenessSeconds } = parsed.data;
  const url = mongodbUrl.reveal();
  if (url.length === 0) throw new MongoSettingsError({ message: "mongodbUrl is empty" });
  return {
    url,
    database: mongodbDatabase,
    transactionReadConcern: mongodbTransactionReadConcern,
    watchLivenessSeconds: mongodbWatchLivenessSeconds,
    schemaSetup: mongodbSchemaSetup,
  };
}
