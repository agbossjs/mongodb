import { seconds } from "@agboss/core/units";
import { MongoClient, type Db } from "mongodb";
import { ENFORCED_CLIENT_OPTIONS } from "./concerns.js";
import { databaseOfUrl, DEFAULT_DATABASE, DEFAULT_WATCH_LIVENESS_SECONDS } from "./settings.js";
import type { MongoConnectionSettings } from "./settings.js";

/** Each connection's settings, for `watchClientOf` — the package's own plumbing, not the class's surface. */
const SETTINGS = new WeakMap<object, MongoConnectionSettings>();

/** Remembers the settings of `connection` (called by its constructor). */
export function rememberSettings(connection: object, settings: MongoConnectionSettings): void {
  SETTINGS.set(connection, settings);
}

/** A client of the child queue's watch, its database and its liveness bound. */
export interface WatchClient {
  readonly client: MongoClient;
  readonly db: Db;
  /** The longest a silently dead connection goes unnoticed, in seconds. */
  readonly livenessSeconds: number;
}

/**
 * A client for one change stream of the child queue (agbossjs/agboss#789): its own, beside the
 * connection's — a stream's connection that died silently leaves the pooled ones of its client dead
 * too, so every attempt to watch again starts on connections never used. One connection: the
 * stream's `getMore`s and the liveness ping take turns on it, so an answered ping proves the very
 * connection the stream listens on. Never throws: the driver connects on the first operation.
 */
export function watchClientOf(connection: object): WatchClient {
  const settings = SETTINGS.get(connection);
  if (settings === undefined) throw new Error("a MongoConnection made outside its constructor");
  const livenessSeconds = settings.watchLivenessSeconds ?? DEFAULT_WATCH_LIVENESS_SECONDS;
  const bound = seconds(livenessSeconds);
  const client = new MongoClient(settings.url, {
    ...ENFORCED_CLIENT_OPTIONS,
    ignoreUndefined: true,
    maxPoolSize: 1,
    // a client dropped as silent ends by itself within the bound: the driver's 30 s defaults would
    // keep its sockets and monitors, and the process, alive long after the instance's stop (#1027).
    // A connection must be up in half the bound (the ping has the rest); the monitor looks every
    // quarter, so the server a dropped client still thinks it knows is given up soon, and the
    // `endSessions` its close waits on fails with it; it never retries: the watch reopens itself
    connectTimeoutMS: seconds(livenessSeconds / 2),
    serverSelectionTimeoutMS: bound,
    socketTimeoutMS: bound,
    retryReads: false,
    retryWrites: false,
    heartbeatFrequencyMS: Math.max(500, seconds(livenessSeconds / 4)),
  });
  return {
    client,
    db: client.db(settings.database ?? databaseOfUrl(settings.url) ?? DEFAULT_DATABASE),
    livenessSeconds,
  };
}
