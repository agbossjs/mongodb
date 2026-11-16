import type { Db } from "mongodb";
import { z } from "zod";
import { MongoSchemaMissingError, MongoSchemaTooNewError } from "../errors.js";
import { Collections } from "./collections.js";
import { refuseLiveLeases } from "./live-leases.js";
import { fillPauseChannels } from "./pause-channels.js";
import { ensureSchema, existingCollectionsOf, requireSimpleCollation } from "./schema.js";

/**
 * The schema's version (agbossjs/agboss#891): one document of `agboss_schema`,
 * `{ _id: "agboss", version }`. A migration makes the collections and indexes first and raises the
 * version last (`$max`: of concurrent runs none lowers it), so a version there means its schema
 * is. A start checks it (`SchemaSetup.Check`, the default) — none, an older one or a collection
 * gone is `MongoSchemaMissingError`, a newer one `MongoSchemaTooNewError` — and never creates
 * anything: the application's pods need no rights to change the schema.
 */

/** One migration of this package: what a version adds. */
export interface MongoMigration {
  readonly version: number;
  readonly name: string;
}

/**
 * The package's migrations, in order. Version 1: every collection, index and the ledger's mark.
 * Version 2 (agbossjs/agboss#962): the checkpoints' `latest_by_step` index; a checkpoint written
 * before has no `step` until the first read of its thread gives it one. Version 3 (#938): the
 * pauses' deadline indexes, the notices' collection, the pauses' `channel`. Version 4
 * (agbossjs/agboss#909, #1117): a tree's cancel mark is the field `cancelRequestedAt` of its lease
 * document (a seed document, token 0, when the cancel comes first), and the pauses' partial index
 * `reassigned_unsent` (#946); no collection — an
 * older build must not run on it, as it would not read the mark.
 */
export const MIGRATIONS: readonly MongoMigration[] = [
  { version: 1, name: "stores" },
  { version: 2, name: "checkpoint_latest_by_step" },
  { version: 3, name: "pause-deadlines-and-notices" },
  { version: 4, name: "execution-cancel-mark" },
];

/** The schema version this package needs: its newest migration's. */
export const SCHEMA_VERSION = Math.max(...MIGRATIONS.map((migration) => migration.version));

/** The `_id` of the version document. */
export const SCHEMA_DOCUMENT_ID = "agboss";

interface SchemaDocument {
  _id: string;
  version: number;
  migratedAt?: Date;
}

const Version = z.object({ version: z.number().int().min(0) });

const versionsOf = (db: Db) => db.collection<SchemaDocument>(Collections.SchemaVersion);

/** The database's schema version; `undefined` when it was never migrated. */
export async function appliedVersionOf(db: Db): Promise<number | undefined> {
  const found = await versionsOf(db).findOne({ _id: SCHEMA_DOCUMENT_ID });
  return found === null ? undefined : Version.parse(found).version;
}

/** `MongoSchemaTooNewError` when `applied` is newer than this package's version. */
function refuseNewer(applied: number | undefined): void {
  if (applied !== undefined && applied > SCHEMA_VERSION)
    throw new MongoSchemaTooNewError({ applied, expected: SCHEMA_VERSION });
}

/**
 * A start's check: the collation of the stores' collections, then the version — this package's
 * one, and every collection of it there. Creates nothing.
 */
export async function checkSchema(db: Db): Promise<void> {
  await requireSimpleCollation(db);
  const applied = await appliedVersionOf(db);
  refuseNewer(applied);
  if (applied === undefined || applied < SCHEMA_VERSION)
    throw new MongoSchemaMissingError({ applied, expected: SCHEMA_VERSION });
  const existing = await existingCollectionsOf(db);
  const missing = Object.values(Collections).filter((name) => !existing.has(name));
  if (missing.length > 0)
    throw new MongoSchemaMissingError({ applied, expected: SCHEMA_VERSION, collections: missing });
}

/** What one migration run found and did. */
export interface SchemaMigration {
  /** The version the database was at; `undefined`: never migrated. */
  readonly from: number | undefined;
  /** The migrations this run applied, in order (none when the database was current). */
  readonly applied: readonly MongoMigration[];
}

/** E11000: two runs' upserts of the version document at once — the other one's is there. */
const isDuplicateKey = (error: unknown): boolean =>
  z.object({ code: z.literal(11000) }).safeParse(error).success;

/** Raises the version to this package's, never lowers it. */
async function raiseVersion(db: Db): Promise<void> {
  const raise = () =>
    versionsOf(db).updateOne(
      { _id: SCHEMA_DOCUMENT_ID },
      { $max: { version: SCHEMA_VERSION }, $currentDate: { migratedAt: true } },
      { upsert: true },
    );
  try {
    await raise();
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    await raise();
  }
}

/** What a migration run may be told. */
export interface MigrateSchemaOptions {
  /** Stops the run before it changes anything and before the version is written. */
  readonly signal?: AbortSignal;
  /** Migrates although an execution lease is live (agbossjs/agboss#1104): the caller knows no old instance runs. */
  readonly allowLiveLeases?: boolean;
}

/**
 * Migrates the database to this package's schema: refuses a newer one, refuses an older one while
 * an execution lease is live on the server's clock (`MongoLiveLeasesError`, #1104: stop every old
 * instance first; `allowLiveLeases` overrides; a database at this version is a no-op whatever is
 * live, and one never migrated has no instance to stop), makes every collection and
 * index missing (idempotent — a collection dropped by hand is made again, the ledger's mark
 * failing closed as agbossjs/agboss#832 says), then raises the version. `signal` stops the run
 * before it changes anything and before the version is written.
 */
export async function migrateSchema(
  db: Db,
  options: MigrateSchemaOptions = {},
): Promise<SchemaMigration> {
  const { signal } = options;
  signal?.throwIfAborted();
  const from = await appliedVersionOf(db);
  refuseNewer(from);
  if (from !== undefined && from < SCHEMA_VERSION && options.allowLiveLeases !== true)
    await refuseLiveLeases(db);
  await ensureSchema(db);
  signal?.throwIfAborted();
  if ((from ?? 0) < 3) await fillPauseChannels(db, signal);
  await raiseVersion(db);
  const applied = MIGRATIONS.filter((migration) => migration.version > (from ?? 0));
  return { from, applied };
}
