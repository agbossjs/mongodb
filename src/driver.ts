import type { EnvRef, SecretRef } from "@agboss/core";
import {
  defineStorageDriver,
  StorageRole,
  type DatabaseDriver,
  type DriverTimeouts,
  type ResolvedSettings,
  type SchemaSetup,
  type StorageMigration,
  type StorageMigrationOptions,
} from "@agboss/core/stores";
import { settingsOfResolved, timeoutSettingsOf } from "./connection/driver-settings.js";
import { migrateMongodb } from "./connection/migrate.js";
import { MongoConnection } from "./connection/mongodb-connection.js";
import type { MongoTransactionReadConcern } from "./connection/concerns.js";
import { MONGODB_STORES } from "./stores/bundles.js";
import { MongoChildExecutionQueueRepository } from "./stores/mongo-child-execution-queue.repository.js";
import { MongoExecutionLeaseRepository } from "./stores/mongo-execution-lease.repository.js";
import { MongoRateLimitRepository } from "./stores/mongo-rate-limit.repository.js";

/** `MongoDriver({ url })` options (agbossjs/agboss#1321). */
export interface MongoDriverOptions {
  /** The replica set: `secret("MONGODB_URL")`, read once when the application starts, never printed. */
  readonly url: SecretRef;
  /**
   * The database the stores' collections are in (default: the URL's, else `agboss`): a name, or an
   * `env(…)` reference read once when the application starts.
   */
  readonly database?: string | EnvRef<string>;
  /** The read concern of the stores' transactions (default `snapshot`). */
  readonly transactionReadConcern?: MongoTransactionReadConcern;
  /** What the start does with the schema (default `SchemaSetup.Check`: it is migrated by `agboss migrate db`). */
  readonly schemaSetup?: SchemaSetup;
  /** The time options, in `Milliseconds`: the change stream's liveness (the PostgreSQL-only ones are refused). */
  readonly timeouts?: DriverTimeouts;
}

/**
 * `agboss migrate db` on the driver's settings, as resolved (agbossjs/agboss#1321f): the schema
 * brought to this version, refusing with `MongoLiveLeasesError` while a lease is live unless the
 * command says `--allow-live-leases`. The names of the migrations applied.
 */
export async function migrateWithDriver(
  resolved: ResolvedSettings,
  options: StorageMigrationOptions,
): Promise<StorageMigration> {
  const settings = settingsOfResolved(resolved);
  const report = await migrateMongodb({
    url: settings.url,
    ...(settings.database === undefined ? {} : { database: settings.database }),
    allowLiveLeases: options.allowLiveLeases,
  });
  return { applied: report.applied.map((migration) => migration.name) };
}

/**
 * The database on MongoDB (`@DatabaseStorage({ driver: MongoDriver({ url: secret("MONGODB_URL") }) })`):
 * every store of the package on the one client of the instance. A `@ClusterStorage` takes the
 * coordination stores' place; the lease store is the application's durable one, where a cluster's
 * lease keeps its ids and its marks. A standalone `mongod` fails closed at start: the stores need
 * transactions and majority writes.
 */
export function MongoDriver(options: MongoDriverOptions): DatabaseDriver {
  const { url, database, transactionReadConcern, schemaSetup, timeouts } = options;
  return defineStorageDriver({
    role: StorageRole.Database,
    backend: "mongodb",
    describes:
      database === undefined
        ? "mongodb"
        : `mongodb (database ${typeof database === "string" ? database : `(${database.variable})`})`,
    settings: {
      kind: "mongodb",
      url,
      ...(database === undefined ? {} : { database }),
      ...(transactionReadConcern === undefined ? {} : { transactionReadConcern }),
      ...(schemaSetup === undefined ? {} : { schemaSetup }),
      ...timeoutSettingsOf(timeouts),
    },
    providers: [MongoConnection, ...MONGODB_STORES],
    leaseStore: MongoExecutionLeaseRepository,
    coordinationStores: [
      MongoExecutionLeaseRepository,
      MongoChildExecutionQueueRepository,
      MongoRateLimitRepository,
    ],
    migrate: migrateWithDriver,
  });
}
