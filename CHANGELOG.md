# Changelog

All notable changes to `@agboss/mongodb`, one section per release, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form. The package is versioned with
`@agboss/core` and released right after it, as one train (agbossjs/agboss `RELEASE_CHECKLIST.md`):
`@agboss/mongodb@X.Y.Z` declares the peer dependency `@agboss/core` `^X.Y.Z` and is built and
tested against the `@agboss/core@X.Y.Z` on npm. Before 1.0 a minor release may break the API; the
exact public surface is `api/mongodb.api.md`. Issue numbers are agbossjs/agboss's, pull requests
this repository's.

## [Unreleased] — 0.1.1 (draft: the first release)

The first published version. An application runs on MongoDB alone: several instances — each its
own process, no shared disk — share every durable store on one replica set (or sharded cluster).
`0.1.0` in `package.json` was never published; every entry below is against the pre-release
builds, so only a store or a test written against `main` of this repository changes.

### Changed

- **`answeredBy` is who answered, `answerer` is who may** (agbossjs/agboss#934, #39) — a pause's
  record, its answer, the answer log and the kept history read as the core names them now;
  documents written by 0.1.0 (`answeredBy` the kind, an answer's `answerer` the person, a log
  entry's `responder`) read with the new names, nothing is migrated. `PauseAnswerRecord.answeredBy`
  is the person now: see the core's "Breaking (silent)".
- **One options object for every error, `Turn` to the end** (#906, completing #890; #35, #38) —
  every error of the package is made from one options object whose keys are its own properties,
  with a `cause` (kept as `.cause`) and a literal instance `code`. The store contract's `lastTerns`
  is `lastTurns`, a summary's `fromTernId` / `toTernId` are `fromTurnId` / `toTurnId` (the core's
  `Turn` names; no `Tern` stays in the API report); the documents are unchanged. A paused run stored
  under `ternId` is read as `turnId`; a stored paused run, pause, pause answer or history record that
  cannot be read is refused with its ids and the invalid field paths (the schema's error as
  `cause`), never with the stored run in the message (its `startInput` may hold PII).
- **A versioned schema, one setup enum, the store bundles** (#891, API review G11; #33, #36) —
  `agboss_schema` holds one document `{ _id: "agboss", version }` (version 1: every collection with
  the simple collation, every index and the ledger's pruning mark). `migrateMongodb({ url, database?,
signal? })` (a `MongoMigrationReport { database, applied, version }`) and `npx agboss-mongodb
migrate [--database <name>]` create and migrate it: idempotent, concurrent runs end in one
  schema, a newer schema is refused (`MongoSchemaTooNewError`, `mongodb.schema-too-new`).
  `schemaSetup: SchemaSetup` (the core's, re-exported; `MongoConnectionSettings.schemaSetup` /
  the environment's `mongodbSchemaSetup`: `check` | `migrate-on-start`) decides what a start does:
  the default `Check` creates nothing — a pod needs no right to change the schema — and fails with
  `MongoSchemaMissingError` (`mongodb.schema-missing`) naming what is missing; `MigrateOnStart`
  migrates first. The command resolves the database as `MongoConnection` does (`--database`, then
  `MONGODB_DATABASE`, then the URL's database, then `agboss`) and accepts `--flag=value`. It prints
  no credentials: stderr passes through `withoutPasswords()`, and a usage error names only a known
  flag. `MONGODB_STORES` (every store) and `MONGODB_DURABLE_STORES` (without the leases, the child
  queue, the rate limits, the fenced effects and the outbound calls: beside `@agboss/redis`'s
  `REDIS_COORDINATION_STORES` and `provide(EXECUTION_ID_STORE, MongoExecutionLeaseRepository)`).
  `deployment()` is split into `topology()` (a report) and `requireSupportedTopology()` (throws);
  the errors are `MongoDeploymentError` (`mongodb.deployment-unsupported`), `MongoDurabilityError`
  (`mongodb.durability-insufficient`) and `MongoCollationNotSimpleError`
  (`mongodb.collation-not-simple`). A failed start closes the client and is not memoised: the next
  `onInit` reconnects. `MongoCheckpointSaver.put` takes LangGraph's full signature (`newVersions`).
- **The core's #890 (API review G8)** — the stores import what they are written with from
  `@agboss/core/stores`; `MongoExecutionRecordRepository`'s methods name the core's record types
  (`Turn`, `NewTurn`, `TurnOutcome`, `NewThread`, `Summary`, `NewSummary`, `ConfigSnapshot`,
  `VersionScore`, `PauseAnswerRecord`), no local aliases; `MongoFencedEffectRepository.runOnce` (was
  `saveResultIfAbsent`; an application injects `FencedEffects`), `deleteByResolvedAtBefore`
  (pauses) and `deleteByCreatedAtBefore` (mesh answers); `ThreadIdsExhaustedError({ generator,
tries })`, `ExecutionFencedError.of(…)`; each error's static `code` is its literal.
- **The core's #889, the execution audit log** — `MongoExecutionLeaseEventRepository` is
  `MongoExecutionAuditLogRepository` (the contract `ExecutionAuditLogRepository`, its records
  `ExecutionAuditEventRecord`); `Collections.ExecutionLeaseEvents` is `Collections.ExecutionAuditLog`
  and the collection keeps its name, `agboss_execution_lease_events`: nothing is migrated. A history
  record kept before #889 keeps its copy of the log as `leaseEvents`.
- **The core's #847, the lease surface** — a lease document stores `token` (a document written by an
  earlier build names it `leaseEpoch` and is still read by it: held, expired, released and finished
  leases alike; every write of a lease stores `token` and unsets the old names); a store's clock is
  read by `StoreClock.source` (the database's `$$NOW` for the leases) — an `isDatabaseTime` read
  would have taken the host's clock; `finish` is `retire`, `saveExecutionIdIfAbsent` is
  `claimExecutionId`, `findQueueDepth` is `countByStatus` (`ChildExecutionQueueCounts`).
- **The core's #834, #817, #825, #810** — the connection's environment fields are made by
  `EnvironmentField`'s helpers; `MongoCostLedgerRepository.saveAll(counters, entries)` takes ledger
  entries only (`assertLedgerEntries`, a `Date` to the millisecond, `costUsd` a `Usd`) and prunes
  with `deleteByMadeAtBefore(cutoff)` (was `deleteEntriesByMadeAtBefore`; an invalid cutoff is
  `CostLedgerCutoffInvalidError`, `cost-ledger.cutoff-invalid`, nothing pruned, the mark never
  lowered); every store declares one `static store = { backend: "mongodb" }`, the A2A task store
  too; a fencing store checks a key's name, business key and fingerprint decision at its entry
  (`FingerprintRequiredError` before any command); `findAllByTenantIdAndStatus({ tenantId, status,
limit, after? })` is keyset-paged on `seq`, its limit and cursor checked (`RangeError`); a lease-log
  document of before is read under the new names in place (`superseded` → `attempt-superseded`,
  `lease-superseded` → `lease-closed`, `supersededLease` → `closedLease`); `FencedEffectKey` is
  `EffectKey` and `fencedKeyIdentityOf` is `effectKeyIdentityOf`; an A2A task keeps a trusted task's
  `meshBodyHash` (an optional field: a task saved before reads as untrusted, charged the contract
  price) and its status's `errorDetails` and `spentUsd` — a status with a field the store does not
  know is refused on read, never read without it.

### Added

- **The direct A2A replies, shared by the pods** (#860; #32, #34) — `MongoA2ADirectMessageRepository`,
  the core's `A2ADirectMessageRepository`: a skill that answers with a `Message` keeps its reply
  once, and a resend of the same `messageId` to any pod gets it — never a second run or charge. The
  message's id is claimed among the A2A task store's messages (a claim of no task, `taskId ""`) in
  the same transaction as its document, so the one unique `_id` decides a race between a task
  message and a direct one in both directions. The retention sweep removes **completed** messages
  only: an attempt in flight keeps its document, its claim and its reply to come, however old; a
  takeover of a lost attempt accepts the message anew, its retention counting from the takeover.
- **The A2A tasks, shared by the pods** (#824; #17) — `MongoA2ATaskRepository`, the core's
  `A2ATaskRepository` on the replica set (`agboss_a2a_tasks`, `agboss_a2a_messages`): the same
  `messageId` sent to two pods at once starts one execution and both answer the same task;
  `GetTask` / `ListTasks` (with its `totalSize`) read any pod's tasks; the retention sweep removes
  finished tasks with their messages in bounded batches. Declares `backend = "mongodb"`: an
  application serving A2A on `MongoExecutionLeaseRepository` lists it, or assembly refuses it
  (`[a2a.task-store-not-shared]`). The fault store set keeps it, so the A2A scenarios run (#880).
- **A run's record by its id** (#808; #15) — `MongoExecutionRecordRepository.findByTenantIdAndRunId`,
  the core's new record contract method (an A2A task's read repair finds its root record however
  many later turns its thread has), on the new index `by_run (tenantId, runId, seq)`.
- **A child queued by one pod wakes the others** (#777; #9) — `MongoChildExecutionQueueRepository`
  implements the core's `watchQueued` with a change stream on the child queue (a document that
  becomes `queued`: an insert, a resume, a lost claim's requeue), started at the `operationTime` of
  a `ping` sent before the watch resolves, so a child queued once it is open is never missed. Idle
  on an empty queue (one held `getMore` per instance per 10 s); a stream the server ends is opened
  again after 1 s doubling to 30 s on the app's `Clock` and wakes the claimers once; a wake lost
  costs at most a sweep. Declared as `StoreCapability.WatchQueued`.
- **Autoscaling counts** (#485; #3) — `MongoChildExecutionQueueRepository.countByStatus()`: the
  queued and running children and the oldest queued one, in one aggregation, feeding
  `agboss.cluster.children.queued` / `.running` / `.oldest_queued_seconds`.
- **The ledger adds each entry once, and prunes under a mark** (#727, #732, #771, #798, #832;
  #8, #10, #12, #24) — `agboss_cost_entries`: each entry's id is inserted (`$setOnInsert`) in the
  transaction that `$inc`s the counters, so a repeated entry and two concurrent saves of one count it
  once. Each entry carries `madeAt` (indexed `by_made_at`; entries of before have none and are never
  pruned); the pruning mark is a document in the collection (`_id` `"\0pruned-before"`, never an
  entry's id). A save of an entry made before the mark that the collection does not hold fails with
  `CostLedgerEntryExpiredError` and adds nothing; a prune that deleted an entry a save holds
  conflicts with it, and the save runs again. The mark is made **with** its collection, in one
  transaction, never lazily: a missing mark — or `prunedBefore` not a date — makes every save and
  prune fail closed with `MongoLedgerMarkMissingError` (`mongodb.ledger-mark-missing`), nothing
  added or deleted, the message giving the remedy. A dropped `agboss_cost_entries` is never made
  again as "never pruned": when `agboss_cost_counters` exists the mark is written with `recreatedAt`
  and no `prunedBefore`, so a late pass cannot be counted twice (it was: 0.125 → 0.375).
- **Every store of the core on a MongoDB replica set** (#527, #527's scaffold #1; #2) —
  `MongoExecutionLeaseRepository` (one conditional single-document command per operation, expiry by
  the server's `$$NOW`), `MongoExecutionRecordRepository`, `MongoExecutionTreeRepository`,
  `MongoPausedExecutionRepository`, `MongoChildExecutionQueueRepository`,
  `MongoCheckpointSaver` (LangGraph's saver, one transaction per task's writes),
  `MongoFencedEffectRepository` (#500: one transaction — the lease locked by a write, the mark
  `$max`, a business key locked before the work), `MongoOutboundCallRepository` (#505, #508: one
  transaction per fenced method), `MongoExecutionAuditLogRepository`, `MongoCostLedgerRepository`,
  `MongoExecutionHistoryRepository`, `MongoRateLimitRepository` (one update pipeline on the key's
  document) and `MongoMeshRequestRepository`. One instance's fenced calls on one lease or key run
  in call order, as PostgreSQL's row locks queue them; "as appended" order comes from a sequence
  document, never a clock or an `ObjectId`.
- **The connection** — `MongoConnection` on the official `mongodb` driver (environment fields
  `mongodbUrl: Secret`, `mongodbDatabase`, `mongodbTransactionReadConcern`, `mongodbSchemaSetup`).
  **A replica set (or a sharded cluster) is required**: a standalone server fails the start with
  `MongoDeploymentError`. **Writes are `majority` on the journal and reads are `majority`
  from the primary**; a URL that asks for less (`w=1`, `w=0`, `w=<n>` or a tag, `journal=false`,
  `readConcernLevel=local|available`, a non-primary `readPreference`, `retryWrites=false`) is refused
  with `MongoDurabilityError`, listing every problem — never quietly overridden. A transaction
  reads at `snapshot` (or `majority`), commits `w=majority` on the journal and reads from the
  primary. Collections and their indexes use the simple collation; one with another is
  `MongoCollationNotSimpleError`.
- **One backend for the fencing stores** (#526) — the lease, fenced-effect and outbound-call stores
  declare `static store = { backend: "mongodb" }`; a mixed layout fails assembly.
- **The database's clock decides a lease's expiry** (#533, #745) — `$$NOW` inside each command that
  takes, renews, yields, reclaims, fences or closes a lease; an outbound call's attempt times
  (`attemptStartedAt`, `firstAttemptStartedAt`, `readAt`) are the `checkedAt` the fence wrote on the
  lease it locked, so a pod whose clock is days off cannot refuse (or allow) a `keyRetention` resend
  wrongly. No migration: the times live in the record; an intent written before has none.
- **Proved on a replica set** — the core's `storeConformance` over every store, the interleaving
  explorer, the linearizability checker, the fault suite (a pod reaches the primary by a direct
  connection through its own proxy; its sabotages run too) and a failover test, in CI shards.
- **The release workflow** (#691; #4) — a pushed tag `mongodb-vX.Y.Z` publishes to npm with
  provenance, only when the tag is the package's version, the commit is on `main`, the pin takes
  `@agboss/core` from the registry at a published version the peer range names
  (`.agboss-version.json` `source: "registry"`, `node scripts/pin-framework.mjs --registry X.Y.Z`)
  and `ci.yml` passed on that commit; a dry run on every pull request that touches it.

### Fixed

- **A question role's pause is read back** (#746; #6) — the stored-pause check took every `ask` for
  an approval's tool call (`callId`, `tool`, `summary`), so a question asked by a flow step (#659)
  or an agent's tool (#712) failed its execution reading its own pause. A question's ask
  (`component.kind: "question"`) is kept as written (it must still be an object); an approval's
  still needs its tool call. The core's `pausedExecutionContract` has the case.
- **A pause record stores its kind and names its step** (#801; #14) — a record's `kind` (`approval`
  | `question`) is read as written, never told by its `component`, and `agent` is `step`. A record
  written before has no `kind`: it is read by the rule it was written under (a question role's
  component → `question`, every other pause → `approval`). The collections have no stored rewrite.
- **The close at an instance's stop ends against a quiet server** (#923; #37) — `MongoConnection`'s
  `onDestroy` gives up the driver's close after a 1 s grace on the `Clock` (a late failure is
  dropped), and so does the queue watch.
