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
 * (`MongoSchemaTooNewError`). The command `agboss-mongodb migrate` runs it.
 */
export async function migrateMongodb(
  options: MigrateMongodbOptions,
): Promise<MongoMigrationReport> {
  options.signal?.throwIfAborted();
  const { url, database } = options;
  const connection = new MongoConnection(database === undefined ? { url } : { url, database });
  try {
    await connection.requireSupportedTopology();
    const { applied } = await migrateSchema(connection.db, options.signal);
    return { database: connection.db.databaseName, applied, version: SCHEMA_VERSION };
  } finally {
    await connection.client.close();
  }
}
