import { AGBossError } from "@agboss/core";

/**
 * The errors of `@agboss/mongodb`: each an `AGBossError` with a stable `code`, so an operator's
 * start-up script and a test tell them apart. A store's own failure (a lost connection, a
 * duplicate key) is the driver's error, rethrown as it is: the operation rejects, the core's
 * hand-over rules apply.
 */

/**
 * The command an operator runs to migrate, as an error message names it: the URL (its credentials)
 * read from `MONGODB_URL`, never on the command line, where the process list and logs would show it.
 */
export const MIGRATE_COMMAND = "npx agboss-mongodb migrate";

/** What a refused setting takes: the message, and what made it fail when it has a cause. */
export interface MongoSettingsErrorOptions {
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * The environment does not give what the MongoDB stores need: `mongodbUrl` (a `Secret` holding a
 * MongoDB connection string), and when set, `mongodbDatabase` (a name),
 * `mongodbTransactionReadConcern` (`snapshot` or `majority`) and `mongodbSchemaSetup` (`check` or
 * `migrate-on-start`). The URL itself is never printed.
 */
export class MongoSettingsError extends AGBossError {
  static override readonly code = "mongodb.settings-invalid" as const;
  declare readonly code: typeof MongoSettingsError.code;
  override name = "MongoSettingsError";

  constructor(options: MongoSettingsErrorOptions) {
    super(options.message, options);
  }
}

/** What `MongoDurabilityError` found: each weak setting of the connection string. */
export interface MongoDurabilityErrorOptions {
  /** Each weak setting found, with why it breaks a guarantee and what to use instead. */
  readonly problems: readonly string[];
  readonly cause?: unknown;
}

/**
 * The connection string asks for a write concern, read concern or read preference under which an
 * acknowledged write can be rolled back, or a read can see one that will be: `w` other than
 * `majority`, `journal=false`, a read concern weaker than `majority`, a read preference other than
 * `primary`. The application does not start — remove the option from `mongodbUrl`; the
 * connection sets `w=majority`, `journal=true`, read concern `majority` itself.
 */
export class MongoDurabilityError extends AGBossError {
  static override readonly code = "mongodb.durability-insufficient" as const;
  declare readonly code: typeof MongoDurabilityError.code;
  override name = "MongoDurabilityError";
  /** Each weak setting found, with why it breaks a guarantee and what to use instead. */
  readonly problems: readonly string[];

  constructor(options: MongoDurabilityErrorOptions) {
    super(
      `the MongoDB connection's concerns are too weak for the stores' guarantees — ${options.problems.join("; ")}`,
      { cause: options.cause },
    );
    this.problems = options.problems;
  }
}

/** What a refused deployment takes: only a cause. */
export interface MongoDeploymentErrorOptions {
  readonly cause?: unknown;
}

/**
 * The server is a standalone `mongod`: it has no majority to acknowledge a write and no
 * multi-document transactions, which the fenced effect and the outbound call need. Run a replica
 * set (a single-node one is enough for development: `mongod --replSet rs0` and `rs.initiate()`),
 * or a sharded cluster.
 */
export class MongoDeploymentError extends AGBossError {
  static override readonly code = "mongodb.deployment-unsupported" as const;
  declare readonly code: typeof MongoDeploymentError.code;
  override name = "MongoDeploymentError";

  constructor(options: MongoDeploymentErrorOptions = {}) {
    super(
      "the MongoDB server is a standalone mongod: the stores need a replica set (write concern majority, multi-document transactions) — start it with --replSet and run rs.initiate(), or connect to a sharded cluster",
      { cause: options.cause },
    );
  }
}

/** What `MongoCollationNotSimpleError` found: the collections of another collation. */
export interface MongoCollationNotSimpleErrorOptions {
  /** The collections found with another collation. */
  readonly collections: readonly string[];
  readonly cause?: unknown;
}

/**
 * A collection of the stores exists with a collation other than the simple (binary) one: its unique
 * keys would compare text by a locale's rules — `Zoë-17` and `zoe-17` one business key, one payment
 * replayed for another. The application does not start and the migration applies nothing; drop the
 * collection (or rename it away) and migrate, which creates it with the simple collation.
 */
export class MongoCollationNotSimpleError extends AGBossError {
  static override readonly code = "mongodb.collation-not-simple" as const;
  declare readonly code: typeof MongoCollationNotSimpleError.code;
  override name = "MongoCollationNotSimpleError";
  /** The collections found with another collation. */
  readonly collections: readonly string[];

  constructor(options: MongoCollationNotSimpleErrorOptions) {
    const { collections } = options;
    super(
      `the MongoDB stores compare keys byte for byte, but ${collections.join(", ")} ${collections.length === 1 ? "has" : "have"} a non-simple collation — drop ${collections.length === 1 ? "it" : "them"} and migrate (\`${MIGRATE_COMMAND}\` with MONGODB_URL set in the environment), which creates the stores' collections with the simple collation`,
      { cause: options.cause },
    );
    this.collections = collections;
  }
}

/** What a schema check found: the version the database is at, the one this package needs. */
export interface MongoSchemaMissingErrorOptions {
  /** The schema version of the database (`agboss_schema`); `undefined`: never migrated. */
  readonly applied: number | undefined;
  /** The schema version of this package. */
  readonly expected: number;
  /** The stores' collections missing although the version is current (dropped by hand). */
  readonly collections?: readonly string[];
  readonly cause?: unknown;
}

/**
 * The database lacks this package's schema — never migrated, migrated by an older package, or a
 * collection of the stores dropped since — and the environment does not set `mongodbSchemaSetup:
 * SchemaSetup.MigrateOnStart`: the application does not start. Run the migration
 * (`agboss-mongodb migrate`, a Kubernetes Job) or set the setting.
 */
export class MongoSchemaMissingError extends AGBossError {
  static override readonly code = "mongodb.schema-missing" as const;
  declare readonly code: typeof MongoSchemaMissingError.code;
  override name = "MongoSchemaMissingError";
  /** The schema version of the database; `undefined`: never migrated. */
  readonly applied: number | undefined;
  /** The schema version of this package. */
  readonly expected: number;
  /** The stores' collections missing (empty when the version is what is missing). */
  readonly collections: readonly string[];

  constructor(options: MongoSchemaMissingErrorOptions) {
    const collections = options.collections ?? [];
    const found =
      collections.length > 0
        ? `is at version ${String(options.applied)} but lacks ${collections.join(", ")}`
        : options.applied === undefined
          ? "was never migrated"
          : `is at version ${String(options.applied)}`;
    super(
      `the MongoDB schema ${found}, this package needs version ${String(options.expected)}: run \`${MIGRATE_COMMAND}\` with MONGODB_URL set in the environment, and MONGODB_DATABASE (or --database) when the app names a database other than the URL's (or set mongodbSchemaSetup: SchemaSetup.MigrateOnStart in the environment)`,
      { cause: options.cause },
    );
    this.applied = options.applied;
    this.expected = options.expected;
    this.collections = collections;
  }
}

/** What `MongoSchemaTooNewError` found: the database's version and this package's. */
export interface MongoSchemaTooNewErrorOptions {
  /** The schema version of the database. */
  readonly applied: number;
  /** The schema version of this package, lower. */
  readonly expected: number;
  readonly cause?: unknown;
}

/**
 * The database was migrated by a newer version of this package than the one running: an
 * application rolled back over a migrated database. Deploy the newer application again — the
 * migrations are never rolled back.
 */
export class MongoSchemaTooNewError extends AGBossError {
  static override readonly code = "mongodb.schema-too-new" as const;
  declare readonly code: typeof MongoSchemaTooNewError.code;
  override name = "MongoSchemaTooNewError";
  /** The schema version of the database. */
  readonly applied: number;
  /** The schema version of this package. */
  readonly expected: number;

  constructor(options: MongoSchemaTooNewErrorOptions) {
    super(
      `the MongoDB schema is at version ${String(options.applied)}, newer than this package's ${String(options.expected)}: a newer @agboss/mongodb migrated it — deploy that version, the migrations are not rolled back`,
      { cause: options.cause },
    );
    this.applied = options.applied;
    this.expected = options.expected;
  }
}

/** What a missing ledger mark knows: what was found instead (#906: its keys are the error's fields). */
export interface MongoLedgerMarkMissingErrorOptions {
  /** The mark's document is there but has no date in `prunedBefore`. */
  readonly malformed?: boolean;
  /** When `agboss_cost_entries` was dropped and made again while the counters held spend. */
  readonly recreatedAt?: Date;
  readonly cause?: unknown;
}

/**
 * The ledger's pruning mark (agbossjs/agboss#771, the document `\u0000pruned-before` of
 * `agboss_cost_entries`, made with the collection — agbossjs/agboss#798) is gone, deleted by hand,
 * or its `prunedBefore` is not a date — or the collection was dropped and a start made it again
 * while `agboss_cost_counters` held spend (agbossjs/agboss#832: its entries are gone, so it cannot
 * tell a counted or pruned entry from a new one): a save adds nothing and fails, and a prune
 * deletes nothing. A restart never seeds it again. Put it back with a mark no lower than any
 * prune's cutoff (`now − retention.costLedgerEntries` covers every prune the sweep made); for a dropped
 * collection, the time it was made again.
 */
export class MongoLedgerMarkMissingError extends AGBossError {
  static override readonly code = "mongodb.ledger-mark-missing" as const;
  declare readonly code: typeof MongoLedgerMarkMissingError.code;
  override name = "MongoLedgerMarkMissingError";
  /** The mark's document is there but has no date in `prunedBefore`. */
  readonly malformed: boolean | undefined;
  /** When `agboss_cost_entries` was dropped and made again while the counters held spend. */
  readonly recreatedAt: Date | undefined;

  constructor(options: MongoLedgerMarkMissingErrorOptions = {}) {
    super(MongoLedgerMarkMissingError.#messageOf(options), { cause: options.cause });
    this.malformed = options.malformed;
    this.recreatedAt = options.recreatedAt;
  }

  static #messageOf(found: MongoLedgerMarkMissingErrorOptions): string {
    if (found.recreatedAt !== undefined) {
      const at = found.recreatedAt.toISOString();
      return `the ledger's pruning mark is missing (agboss_cost_entries was dropped and made again at ${at} while agboss_cost_counters held spend: the entries it counted and the mark are gone): nothing was added — put the mark back at that time, so an entry made before it is refused and never counted again: db.agboss_cost_entries.replaceOne({ _id: "\\u0000pruned-before" }, { prunedBefore: new Date("${at}") })`;
    }
    const what =
      found.malformed === true
        ? 'agboss_cost_entries\'s "\\u0000pruned-before" document has no date in prunedBefore'
        : 'agboss_cost_entries has no "\\u0000pruned-before" document';
    return `the ledger's pruning mark is missing (${what}): nothing was added — put it back with a mark no lower than any prune's cutoff, e.g. db.agboss_cost_entries.replaceOne({ _id: "\\u0000pruned-before" }, { prunedBefore: new Date(Date.now() - 86400000) }, { upsert: true }) for the default retention.costLedgerEntries of a day`;
  }
}
