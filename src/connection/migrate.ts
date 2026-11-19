import { MongoConnection } from "./mongodb-connection.js";
import { migrateSchema, SCHEMA_VERSION } from "./schema-version.js";

/** What `migrateMongodb` takes: the replica set, the database, and a signal that stops the run. */
export interface MigrateMongodbOptions {
  /** The replica set: `mongodb://host1,host2,host3/?replicaSet=rs0` (or `mongodb+srv://…`). */
  readonly url: string;
  /** The database the stores' collections are in (default: the URL's, else `agboss`). */
  readonly database?: string;
  /** Aborted → the run stops before it changes anything, or before it writes the version. */
  readonly signal?: AbortSignal;
  /**
   * Migrates although an execution lease is live on the server's clock (default `false`: with
   * migrations pending, a live lease is `MongoLiveLeasesError`, agbossjs/agboss#1104). Pass it
   * only when no instance of the previous version runs — an idle one holds no lease and is not seen.
   */
  readonly allowLiveLeases?: boolean;
}

/** One migration a run applied. */
export interface MongoAppliedMigrationReport {
  readonly version: number;
  readonly name: string;
}

/** What one run did: a second run on the same database reports `applied: []`. */
export interface MongoMigrationReport {
  /** The database migrated. */
  readonly database: string;
  /** The package's migrations this run applied, in order. */
  readonly applied: readonly MongoAppliedMigrationReport[];
  /** The schema version of the database now. */
  readonly version: number;
}

/**
 * Migrates the database to this package's schema (agbossjs/agboss#891) — every collection with the
 * simple collation, every index, the ledger's mark, then the version document `agboss_schema` —
 * idempotent, so concurrent runs end in one schema and a run after them applies nothing. Refuses a
 * standalone `mongod` (`MongoDeploymentError`), a collection of another collation
 * (`MongoCollationNotSimpleError`) and a database a newer package migrated
 * (`MongoSchemaTooNewError`), and — with migrations pending on a migrated database — a live execution
 * lease (`MongoLiveLeasesError`: stop every old instance first, `allowLiveLeases` overrides). The command `agboss-mongodb migrate` runs it.
 */
export async function migrateMongodb(
  options: MigrateMongodbOptions,
): Promise<MongoMigrationReport> {
  options.signal?.throwIfAborted();
  const { url, database } = options;
  // an absent database is the URL's, an absent signal or switch none: `undefined` passed is the same
  const connection = new MongoConnection({ url, database });
  try {
    await connection.requireSupportedTopology();
    const { applied } = await migrateSchema(connection.db, {
      signal: options.signal,
      allowLiveLeases: options.allowLiveLeases,
    });
    return { database: connection.db.databaseName, applied, version: SCHEMA_VERSION };
  } finally {
    await connection.client.close();
  }
}
