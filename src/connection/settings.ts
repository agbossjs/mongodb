import type { SchemaSetup } from "@agboss/core/stores";
import { MongoSettingsError } from "../errors.js";
import type { MongoTransactionReadConcern } from "./concerns.js";

/** The database the stores use when the driver names no `database`. */
export const DEFAULT_DATABASE = "agboss";

/**
 * How long a dead change stream connection may go unnoticed (agbossjs/agboss#789) when the
 * driver gives no `timeouts.watchLiveness`: a ping every half of it, an answer due
 * within the other half.
 */
export const DEFAULT_WATCH_LIVENESS_SECONDS = 10;

/**
 * The longest liveness bound the watch accepts, in seconds (agbossjs/agboss#1129): an hour, far
 * under the 2^31-1 ms (about 24.8 days) a Node timer holds — beyond it the timer fires at once, the
 * watch fails and the instance silently falls back to the sweep.
 */
export const MAX_WATCH_LIVENESS_SECONDS = 3600;

/**
 * `seconds` when the child queue's watch can run on it — a whole number from 2 to `MAX_WATCH_LIVENESS_SECONDS`, as the
 * driver's option is checked —, else `MongoSettingsError` naming `watchLivenessSeconds`
 * (agbossjs/agboss#1029): a settings object a script or a provider builds is trusted no more than
 * the driver's options.
 */
export function checkedWatchLivenessOf(seconds: number | undefined): number | undefined {
  if (
    seconds === undefined ||
    (Number.isInteger(seconds) && seconds >= 2 && seconds <= MAX_WATCH_LIVENESS_SECONDS)
  )
    return seconds;
  throw new MongoSettingsError({
    message: `watchLivenessSeconds must be a whole number of at least 2 and at most ${String(MAX_WATCH_LIVENESS_SECONDS)}, got ${String(seconds)}`,
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
   * `DEFAULT_WATCH_LIVENESS_SECONDS`, 10, at least 2, at most `MAX_WATCH_LIVENESS_SECONDS`, 3600): the watch pings the server every half of it
   * and gives the answer the other half, then warns, opens the stream on a new client and wakes
   * once.
   * Another value (0, 1, a negative or a fractional number, or one above 3600) is a `MongoSettingsError` at construction
   * (agbossjs/agboss#1029), as in the driver.
   */
  readonly watchLivenessSeconds?: number;
  /**
   * What the start does with the schema (agbossjs/agboss#891): `SchemaSetup.Check` (the default)
   * refuses a database not migrated to this package's version; `SchemaSetup.MigrateOnStart`
   * migrates it first.
   */
  readonly schemaSetup?: SchemaSetup;
  /**
   * With `SchemaSetup.MigrateOnStart` and migrations pending, the start waits for the execution
   * leases of the old instances to lapse (twice the longest lease left, at least a minute, at most
   * ten) and fails with `MongoLiveLeasesError` while one is live (agbossjs/agboss#1104: no rolling
   * upgrade across a schema change — stop the old instances first). `true` migrates over live
   * leases: for an operator who accepts the risk. The migrate command's `--allow-live-leases`.
   */
  readonly allowLiveLeases?: boolean;
}
