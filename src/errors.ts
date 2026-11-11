import { AGBossError } from "@agboss/core";

/**
 * The errors of `@agboss/mongodb`: each an `AGBossError` with a stable `code`, so an operator's
 * start-up script and a test tell them apart. A store's own failure (a lost connection, a
 * duplicate key) is the driver's error, rethrown as it is: the operation rejects, the core's
 * hand-over rules apply.
 */

/**
 * The environment does not give what the MongoDB stores need: `mongodbUrl` (a `Secret` holding a
 * MongoDB connection string), and when set, `mongodbDatabase` (a name) and
 * `mongodbTransactionReadConcern` (`snapshot` or `majority`). The URL itself is never printed.
 */
export class MongoSettingsError extends AGBossError {
  static override readonly code = "mongodb.settings-invalid" as const;
  override name = "MongoSettingsError";
}

/**
 * The connection string asks for a write concern, read concern or read preference under which an
 * acknowledged write can be rolled back, or a read can see one that will be: `w` other than
 * `majority`, `journal=false`, a read concern weaker than `majority`, a read preference other than
 * `primary`. The application does not start — remove the option from `mongodbUrl`; the
 * connection sets `w=majority`, `journal=true`, read concern `majority` itself.
 */
export class MongoConcernTooWeakError extends AGBossError {
  static override readonly code = "mongodb.concern-too-weak" as const;
  override name = "MongoConcernTooWeakError";
  /** Each weak setting found, with why it breaks a guarantee and what to use instead. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `the MongoDB connection's concerns are too weak for the stores' guarantees — ${problems.join("; ")}`,
    );
    this.problems = problems;
  }
}

/**
 * The server is a standalone `mongod`: it has no majority to acknowledge a write and no
 * multi-document transactions, which the fenced effect and the outbound call need. Run a replica
 * set (a single-node one is enough for development: `mongod --replSet rs0` and `rs.initiate()`),
 * or a sharded cluster.
 */
export class MongoReplicaSetRequiredError extends AGBossError {
  static override readonly code = "mongodb.replica-set-required" as const;
  override name = "MongoReplicaSetRequiredError";

  constructor() {
    super(
      "the MongoDB server is a standalone mongod: the stores need a replica set (write concern majority, multi-document transactions) — start it with --replSet and run rs.initiate(), or connect to a sharded cluster",
    );
  }
}

/**
 * A collection of the stores exists with a collation other than the simple (binary) one: its unique
 * keys would compare text by a locale's rules — `Zoë-17` and `zoe-17` one business key, one payment
 * replayed for another. The application does not start; drop the collection (or rename it away) so
 * the connection creates it with the simple collation.
 */
export class MongoCollationError extends AGBossError {
  static override readonly code = "mongodb.collation-not-simple" as const;
  override name = "MongoCollationError";
  /** The collections found with another collation. */
  readonly collections: readonly string[];

  constructor(collections: readonly string[]) {
    super(
      `the MongoDB stores compare keys byte for byte, but ${collections.join(", ")} ${collections.length === 1 ? "has" : "have"} a non-simple collation — drop ${collections.length === 1 ? "it" : "them"}, the connection creates the stores' collections with the simple collation`,
    );
    this.collections = collections;
  }
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
  override name = "MongoLedgerMarkMissingError";

  constructor(found: { readonly malformed?: boolean; readonly recreatedAt?: Date } = {}) {
    super(MongoLedgerMarkMissingError.#messageOf(found));
  }

  static #messageOf(found: { readonly malformed?: boolean; readonly recreatedAt?: Date }): string {
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
