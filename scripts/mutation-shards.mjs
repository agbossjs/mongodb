/**
 * The mutation shards of this package (agbossjs/agboss#1213, as the core's stryker.config.mjs,
 * #533 item 3, #626): each the money-path modules it mutates and the tests that must kill them.
 * Read by `stryker.config.mjs` (what to mutate) and `vitest.mutation.config.ts` (what to run);
 * `MUTATION_SHARD` picks one. The tests need the servers of `npm run coverage`
 * (`AGBOSS_MONGODB_TEST_URL`, a replica set; `AGBOSS_MONGODB_STANDALONE_TEST_URL`), as every test here.
 */
const CONFORMANCE = "tests/contracts/store-conformance.test.ts";
/**
 * The stores of the shared conformance file a shard runs (`contracts`: keys of `storeConformance`'s
 * `stores`; `tests/contracts/store-conformance.test.ts` reads them from `MUTATION_SHARD`). Not a
 * `testNamePattern`: Vitest 3 applies that over Stryker's own per-test filter on every mutant, so
 * a mutant covered by two tests ran them all (agbossjs/mongodb#103). The fencing stores come
 * together: the explorer of interleavings runs on a lease store and asks for them.
 */
const FENCING = ["executionLease", "fencedEffect", "outboundCall", "executionAuditLog"];

export const SHARDS = {
  // the lease document: its epochs, expiry, finish, yield and reclaim on the server's clock, the
  // tree's durable cancel mark (agbossjs/agboss#909, #1117, #1152) as the lease store reads and sets it
  leases: {
    mutate: [
      "src/stores/mongo-execution-lease.repository.ts",
      "src/stores/mongo-lease-marks.repository.ts",
      "src/stores/lease-documents.ts",
      "src/stores/lease-marks.ts",
      "src/stores/lease-seed.ts",
      "src/stores/status-log.ts",
      "src/stores/store-time.ts",
    ],
    tests: [CONFORMANCE, "tests/stores/{lease-*,cluster-mirror,status-log}.test.ts"],
    contracts: ["executionLease"],
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
    contracts: FENCING,
  },
  // the fenced effect and the outbound call: one effect per key, the business key's fingerprint,
  // the intent, its attempts and outcomes, the paged listing
  "effects-and-calls": {
    mutate: [
      "src/stores/mongo-fenced-effect.repository.ts",
      "src/stores/fenced-effects/*.ts",
      "src/connection/ambient.ts",
      "src/stores/key-entry.ts",
      "src/stores/keys.ts",
      "src/stores/mongo-outbound-call.repository.ts",
      "src/stores/outbound-calls/outbound-call-documents.ts",
      "src/stores/outbound-calls/outbound-call-lookup.ts",
      "src/stores/outbound-call-pages.ts",
    ],
    tests: [CONFORMANCE, "tests/stores/{fenced-effect*,outbound-call*}.test.ts"],
    contracts: FENCING,
  },
  // the pause store: decisions, answers, notices and their claims (agbossjs/agboss#946), deadlines
  // and their timers (#941, #1064), reassignment
  pauses: {
    // two mutants at a time: three loops that page for ever starve the servers' elections, and the mutants running then end
    // in transport errors, RuntimeErrors Stryker leaves out of the score (agbossjs/mongodb#103)
    concurrency: 2,
    mutate: ["src/stores/mongo-paused-execution.repository.ts", "src/stores/paused/*.ts"],
    tests: [CONFORMANCE, "tests/stores/{pause*,paused*}.test.ts"],
    contracts: ["pausedExecution"],
  },
  // money and its limits: the cost ledger and its pruning mark, the rate limits
  money: {
    // two mutants at a time (as `pauses`): at three, a transport error in a test's reset ended some mutant of the shard as a
    // RuntimeError, which Stryker leaves out of the score, in most runs on a loaded machine (agbossjs/mongodb#103)
    concurrency: 2,
    mutate: [
      "src/stores/mongo-cost-ledger.repository.ts",
      "src/connection/ledger-mark.ts",
      "src/stores/mongo-rate-limit.repository.ts",
      "src/stores/rate-limits/*.ts",
    ],
    tests: [CONFORMANCE, "tests/stores/{cost-ledger*,rate-limit*}.test.ts"],
    contracts: ["costLedger", "rateLimit"],
  },
  // the child queue: a claim, a save, a release (the queue store itself)
  queue: {
    mutate: ["src/stores/mongo-child-execution-queue.repository.ts", "src/stores/child-queue/*.ts"],
    tests: [CONFORMANCE, "tests/stores/{queue-watch,child-queue*}.test.ts"],
    contracts: ["childExecutionQueue"],
  },
  // the child queue's watch (agbossjs/agboss#777, #1088, #1345): its change stream, the cursors it
  // knows of, the close that kills them, and the client it runs on
  "queue-watch": {
    mutate: ["src/stores/queue-{changes,watch,watch-cursors}.ts", "src/connection/watch-client.ts"],
    tests: ["tests/stores/queue-watch*.test.ts"],
  },
  // the A2A direct-message store (agbossjs/mongodb#104): one accept of a message on two instances, the
  // once-only reply by its attempt, the takeover of an expired attempt (`retakeIfExpired`: a live attempt
  // is never retaken, or two pods run one paid message), the retention that never frees an id an attempt holds
  "a2a-direct": {
    mutate: [
      "src/stores/mongo-a2a-direct-message.repository.ts",
      "src/stores/a2a-direct-messages/*.ts",
    ],
    tests: [CONFORMANCE, "tests/stores/a2a-direct-message*.test.ts"],
    contracts: ["a2aDirectMessage"],
  },
  // the A2A task store (agbossjs/mongodb#105, agbossjs/agboss#824): of two pods accepting one message exactly one
  // saves it (`saveIfAbsent`, one transaction), the status moves by a compare-and-set on its version and never off
  // a terminal state (`compareAndSetStatus`), the message and its reply are kept once, the retention sweep and the
  // page of `list`
  "a2a-tasks": {
    mutate: ["src/stores/mongo-a2a-task.repository.ts", "src/stores/a2a-tasks/*.ts"],
    tests: [CONFORMANCE, "tests/stores/{a2a-task*,a2a-message-save,a2a-direct-message*}.test.ts"],
    contracts: ["a2aTask", "a2aDirectMessage"],
  },
  // the mesh request store (agbossjs/mongodb#105, agbossjs/agboss#483): of two pods admitting one idempotency key
  // exactly one inserts it, which is what runs a trusted repeat `tools/call` once
  "mesh-requests": {
    mutate: ["src/stores/mongo-mesh-request.repository.ts"],
    tests: [CONFORMANCE, "tests/stores/mesh-request*.test.ts"],
    contracts: ["meshRequest"],
  },
  // the execution record store (agbossjs/mongodb#105, agbossjs/agboss#1367): `completeIfStatus` is one update
  // filtered on the expected status, the only guard of the paused -> running mark of an answer that reaches
  // whichever instance, before and without any lease; a thread id is created once, the first answer of a pause
  // is kept, and the reads recovery, replay, eval and memory rely on
  "execution-records": {
    mutate: [
      "src/stores/mongo-execution-record.repository.ts",
      "src/stores/records/record-writes.ts",
      "src/stores/records/record-interrupt.ts",
      "src/stores/records/record-threads.ts",
      "src/stores/records/record-idle.ts",
    ],
    tests: [CONFORMANCE, "tests/stores/{execution-record*,minted-thread}.test.ts"],
    contracts: ["executionRecord"],
  },
  // the execution tree store (agbossjs/mongodb#105, agbossjs/agboss#105): `saveIfAbsentInTree`, one upsert with
  // `$setOnInsert`, is the only guard of every once-only key of a tree: the public `saveIfAbsent` of user code in any
  // execution (a child on any instance, no lease of the root) and the child-failure claim of passes that overlap during
  // a lease takeover; the keys of a tenant's root, the value as JSON, the delete of one tree
  "execution-tree": {
    mutate: ["src/stores/mongo-execution-tree.repository.ts"],
    tests: [CONFORMANCE, "tests/stores/execution-tree*.test.ts"],
    contracts: ["executionTree"],
  },
  // the checkpoint saver (agbossjs/mongodb#104, agbossjs/agboss#1165): a thread's checkpoints in the order
  // of their step, the pending writes kept as first written, `latestByStep` as one indexed read
  checkpoints: {
    mutate: ["src/stores/mongo-checkpoint-saver.ts", "src/stores/checkpoints/*.ts"],
    tests: [CONFORMANCE, "tests/stores/checkpoint-*.test.ts"],
    contracts: ["checkpointSaver"],
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
    // one mutant at a time: most of the mutants are static (each runs every covering test with the environment reloaded), and
    // with two or three at once on CI's runners a few of them ended as Timeouts of the clock, a different few each run (agbossjs/mongodb#103)
    concurrency: 1,
    mutate: ["src/connection/mongodb-connection.ts"],
    tests: [
      "tests/connection/{mongodb-connection*,watch-liveness-*,driver-internals}.test.ts",
      "tests/integration/{mongodb-connection.integration,retries,migrate-on-start-leases}.test.ts",
    ],
  },
  // the schema and its migrations: its collections, indexes and validators, its version, the
  // migration to it, and the live-lease guard of a migration (agbossjs/agboss#1104, #1260)
  migrations: {
    // a migration per case: the hooks (a database made and migrated again) dominate the net time
    mutate: [
      "src/connection/migrate.ts",
      "src/connection/schema.ts",
      "src/connection/schema-version.ts",
      "src/connection/collections.ts",
      "src/connection/live-leases.ts",
    ],
    tests: [
      "tests/integration/{schema,schema-edges,schema-version,schema-version-edges,live-leases,migrate-on-start-leases}.test.ts",
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
    // one mutant at a time, as `connection`
    concurrency: 1,
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
