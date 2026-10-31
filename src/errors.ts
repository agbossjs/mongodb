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
  static override readonly code: string = "mongodb.settings-invalid";
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
  static override readonly code: string = "mongodb.concern-too-weak";
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
  static override readonly code: string = "mongodb.replica-set-required";
  override name = "MongoReplicaSetRequiredError";

  constructor() {
    super(
      "the MongoDB server is a standalone mongod: the stores need a replica set (write concern majority, multi-document transactions) — start it with --replSet and run rs.initiate(), or connect to a sharded cluster",
    );
  }
}
