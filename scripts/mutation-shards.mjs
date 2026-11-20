/**
 * The mutation shards of this package (agbossjs/agboss#1213, as the core's stryker.config.mjs,
 * #533 item 3, #626): each the money-path modules it mutates and the tests that must kill them.
 * Read by `stryker.config.mjs` (what to mutate) and `vitest.mutation.config.ts` (what to run);
 * `MUTATION_SHARD` picks one. The tests need the servers of `npm run coverage`
 * (`AGBOSS_MONGODB_TEST_URL`, a replica set; `AGBOSS_MONGODB_STANDALONE_TEST_URL`), as every test here.
 */
const CONFORMANCE = "tests/contracts/store-conformance.test.ts";
/**
 * Only these suites of the store contracts, and every case of the shard's other files: the
 * contracts of the other shards' stores take most of a run and kill none of its mutants.
 */
const conformanceOf = (...suites) =>
  String.raw`(${suites.join("|")}) \(MongoDB\)|^(?!.*\(MongoDB\))`;

export const SHARDS = {
  // the lease document: its epochs, expiry, finish, yield and reclaim on the server's clock, the
  // tree's durable cancel mark (agbossjs/agboss#909, #1117, #1152) as the lease store reads and sets it
  leases: {
    mutate: [
      "src/stores/mongo-execution-lease.repository.ts",
      "src/stores/lease-documents.ts",
      "src/stores/store-time.ts",
    ],
    tests: [CONFORMANCE, "tests/stores/lease-*.test.ts"],
    testNamePattern: conformanceOf("lease contract", "interleavings"),
  },
  // the fence every fencing write checks in its own transaction: the lease written, the business
  // key locked, the tree's cancel mark read after its root's document is written (#909, #1117)
  fence: {
    mutate: [
      "src/stores/fence.ts",
      "src/stores/cancel-fence.ts",
      "src/stores/outbound-calls/lease-state.ts",
    ],
    tests: [CONFORMANCE, "tests/stores/{fence-*,cancel-fence}.test.ts"],
    testNamePattern: conformanceOf(
      "fenced effect contract",
      "outbound call contract",
      "interleavings",
      "store set",
    ),
  },
  // the fenced effect and the outbound call: one effect per key, the business key's fingerprint,
  // the intent, its attempts and outcomes, the paged listing
  "effects-and-calls": {
    mutate: [
      "src/stores/mongo-fenced-effect.repository.ts",
      "src/stores/fenced-effects/*.ts",
      "src/stores/key-entry.ts",
      "src/stores/keys.ts",
      "src/stores/mongo-outbound-call.repository.ts",
      "src/stores/outbound-calls/outbound-call-documents.ts",
      "src/stores/outbound-call-pages.ts",
    ],
    tests: [CONFORMANCE, "tests/stores/{fenced-effect*,outbound-call*}.test.ts"],
    testNamePattern: conformanceOf(
      "fenced effect contract",
      "outbound call contract",
      "interleavings",
      "store set",
    ),
  },
  // the pause store: decisions, answers, notices and their claims (agbossjs/agboss#946), deadlines
  // and their timers (#941, #1064), reassignment
  pauses: {
    mutate: [
      "src/stores/mongo-paused-execution.repository.ts",
      "src/stores/paused/*.ts",
      "src/connection/pause-channels.ts",
    ],
    tests: [CONFORMANCE, "tests/stores/{pause*,paused*}.test.ts"],
    testNamePattern: conformanceOf("paused execution contract"),
  },
  // money and its limits: the cost ledger and its pruning mark, the rate limits
  money: {
    mutate: [
      "src/stores/mongo-cost-ledger.repository.ts",
      "src/connection/ledger-mark.ts",
      "src/stores/mongo-rate-limit.repository.ts",
      "src/stores/rate-limits/*.ts",
    ],
    tests: [CONFORMANCE, "tests/stores/{cost-ledger*,rate-limit*}.test.ts"],
    testNamePattern: conformanceOf("cost ledger contract", "rate limit contract"),
  },
  // the child queue: a claim, a save, a release (the queue store itself)
  queue: {
    mutate: ["src/stores/mongo-child-execution-queue.repository.ts"],
    tests: [CONFORMANCE, "tests/stores/{queue-watch,child-queue*}.test.ts"],
    testNamePattern: conformanceOf("child execution queue contract"),
  },
  // the child queue's watch (agbossjs/agboss#777, #1088, #1345): its change stream, the cursors it
  // knows of, the close that kills them, and the client it runs on
  "queue-watch": {
    mutate: ["src/stores/queue-{changes,watch,watch-cursors}.ts", "src/connection/watch-client.ts"],
    tests: ["tests/stores/queue-watch*.test.ts"],
  },
  // the order and the numbers of this instance's writes: the commit order of the calls on one
  // key (agbossjs/agboss#527) and the counter behind every `seq` (#661, #682)
  ordering: {
    mutate: ["src/stores/{local-order,sequence}.ts"],
    tests: ["tests/stores/{local-order,sequence}*.test.ts", "tests/stores/fence-keys.test.ts"],
  },
  // the settings read from the environment and from a settings object (agbossjs/agboss#789, #1029,
  // #1129): the URL's database, the liveness bound, every field named when it is wrong
  settings: {
    mutate: ["src/connection/settings.ts"],
    tests: ["tests/connection/{settings*,environment-fields,watch-liveness-*}.test.ts"],
  },
  // the `agboss-mongodb` command (agbossjs/agboss#891): its arguments, its exit codes, and the
  // passwords it never prints
  cli: {
    mutate: ["src/cli.ts"],
    tests: ["tests/cli/*.test.ts"],
  },
  // the connection's assembly (agbossjs/agboss#891, #1017, #1104): its client and its checks, the
  // transaction and the commit it reads, the start that is retried after a failure, the stop
  connection: {
    mutate: ["src/connection/mongodb-connection.ts"],
    tests: [
      "tests/connection/{mongodb-connection*,watch-liveness-*,driver-internals}.test.ts",
      "tests/integration/{mongodb-connection.integration,retries,migrate-on-start-leases}.test.ts",
    ],
  },
  // the schema and its migrations: its collections, indexes and validators, its version, the
  // migration to it, and the live-lease guard of a migration (agbossjs/agboss#1104, #1260)
  migrations: {
    mutate: [
      "src/connection/migrate.ts",
      "src/connection/schema.ts",
      "src/connection/schema-version.ts",
      "src/connection/collections.ts",
      "src/connection/live-leases.ts",
    ],
    tests: [
      "tests/integration/{schema,schema-version,live-leases,migrate-on-start-leases}.test.ts",
      "tests/connection/schema-*.test.ts",
      "tests/cli/*.test.ts",
    ],
  },
  // the outcome of a write whose answer was lost (agbossjs/agboss#1017, mongodb#76, #82): a
  // whitelist, "not applied" only where the server's reply proves it, else StoreOutcomeUnknownError
  outcome: {
    mutate: ["src/connection/{classified-db,outcome}.ts"],
    tests: [
      "tests/connection/{outcome,outcome-bulk,classified-db}.test.ts",
      "tests/stores/write-outcome-*.test.ts",
    ],
  },
  // every store call bounded and read (agbossjs/agboss#928, #1064): the start checks (durable
  // writes, a replica set), the concerns, the transaction, the bounded close, the liveness ping,
  // and the stored texts read back
  "store-bound": {
    mutate: [
      "src/connection/{close-bounded,concerns,deployment,heartbeat,transaction}.ts",
      "src/stores/{unreadable,framework-json}.ts",
    ],
    tests: [
      "tests/connection/*.test.ts",
      "tests/integration/{mongodb-connection.integration,retries}.test.ts",
      "tests/stores/stored-not-json*.test.ts",
    ],
    // the migrations shard's (they make and migrate a database per case) and the outcome shard's
    exclude: [
      "tests/connection/schema-*.test.ts",
      "tests/connection/{outcome,outcome-bulk,classified-db}.test.ts",
    ],
  },
};

/** The shard `MUTATION_SHARD` names (default `leases`); a name of none fails. */
export function chosenShard() {
  const name = process.env.MUTATION_SHARD ?? "leases";
  const shard = SHARDS[name];
  if (shard === undefined)
    throw new Error(`MUTATION_SHARD: "${name}" is none of ${Object.keys(SHARDS).join(", ")}`);
  return { name, ...shard };
}
