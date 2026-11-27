# @agboss/mongodb

MongoDB stores for [AGBoss](https://github.com/agbossjs/agboss): several application instances —
each its own process, no shared disk — share execution trees on one MongoDB **replica set**, with
the same guarantees as [`@agboss/postgres`](https://github.com/agbossjs/postgres). A pod that dies
mid-run is taken over by another from its last checkpoint; a zombie that wakes up can no longer
write (every fenced write carries its lease's epoch); a charge, a booking or a mail is made once per
key; a call that leaves the system is recorded before it is sent and reconciled, never sent again
blindly. Budgets, rate limits, history and mesh deduplication are shared by every pod.

> Status: every store contract of the core — leases, execution ids, records and threads, trees,
> pauses, the child queue, checkpoints, the fenced effect with business keys, the audit log, the
> cost ledger, the execution history, rate limits, mesh requests and outbound calls. Each passes the
> core's `storeConformance` (the interleaving explorer included) and the fault suite against a real
> replica set ([Tests](#tests)). Not published to npm yet.

## Install

```sh
npm install @agboss/mongodb
```

Peer dependencies: `@agboss/core` `^0.1.1`, `@langchain/core`, `@langchain/langgraph-checkpoint`.
Dependencies: the official `mongodb` driver (7.x), `zod`.

## 1. Declare the database

<!-- snippet-context
declare class DeskWorkflow {}
-->

```ts
import { Application, DatabaseStorage, secret } from "@agboss/core";
import { hours } from "@agboss/core/units";
import { MongoDriver } from "@agboss/mongodb";

@DatabaseStorage({
  name: "desk-database",
  description: "The desk's MongoDB replica set",
  driver: MongoDriver({ url: secret("MONGODB_URL") }), // every store below, on one client
  auditLogTtl: hours(24),
  ledgerEntriesTtl: hours(24),
})
export class DeskDatabase {}

@Application({
  name: "desk",
  version: "1.0.0",
  storage: DeskDatabase,
  workflows: [DeskWorkflow],
})
export class DeskApplication {}
```

`MongoDriver` (agbossjs/agboss#1321) provides `MongoConnection` and every store of the table below
(`MONGODB_STORES` is that list; `MONGODB_DURABLE_STORES` the same without the coordination stores —
the leases, the child queue, the rate limits — and the two that check the lease in their own
transaction, fenced effects and outbound calls). A `@ClusterStorage` takes the coordination stores'
place — Redis's, for example — and the lease store stays the application's durable one: the Redis
leases keep their execution ids and their marks in it. A store class listed in `providers` beside a
`storage` is `[storage.providers-conflict]`: choose it in the driver, not in the list. On Redis
leases an application lists no fenced-effect or outbound-call store: their write checks the lease in
its own transaction.

| Store                                | How it is atomic                                                                                                                                                                | Collections                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `MongoExecutionLeaseRepository`      | one conditional single-document command per operation; time `$$NOW`                                                                                                             | `agboss_execution_leases`, `agboss_execution_ids`                                          |
| `MongoFencedEffectRepository`        | **a transaction**: the lease locked by a write, the mark, the key's lock, the result, the work                                                                                  | `agboss_fenced_effect_marks`, `…_results`, `agboss_fenced_key_locks`                       |
| `MongoOutboundCallRepository`        | **a transaction** per fenced method: the lease and mark, then one compare-and-set                                                                                               | `agboss_outbound_calls`                                                                    |
| `MongoExecutionAuditLogRepository`   | one insert (an append), ordered by a sequence                                                                                                                                   | `agboss_execution_lease_events`                                                            |
| `MongoExecutionRecordRepository`     | one command per write; `completeIfStatus` a compare-and-set                                                                                                                     | `agboss_threads`, `agboss_execution_records`, `…_scores`, `…_summaries`, `…_pause_answers` |
| `MongoExecutionTreeRepository`       | an upsert with `$setOnInsert`                                                                                                                                                   | `agboss_execution_tree_keys`                                                               |
| `MongoPausedExecutionRepository`     | every move of a pending pause a compare-and-set (its deadline in the filter) in a transaction with its notices; a mailbox move one conditional command                          | `agboss_paused_executions`, `agboss_pauses`, `agboss_pause_notices`                        |
| `MongoChildExecutionQueueRepository` | a claim is one `findOneAndUpdate`; a save one upsert                                                                                                                            | `agboss_child_execution_queue`                                                             |
| `MongoCheckpointSaver`               | one replace per checkpoint; a task's writes in one transaction                                                                                                                  | `agboss_checkpoints`, `agboss_checkpoint_writes`                                           |
| `MongoCostLedgerRepository`          | **a transaction** of `$inc`s: every counter of a save, or none; the entries' pruning mark read in it, a prune raising it and deleting in one transaction (agbossjs/agboss#771)  | `agboss_cost_counters`, `agboss_cost_max_spend`, `agboss_cost_entries`                     |
| `MongoExecutionHistoryRepository`    | a replace with upsert                                                                                                                                                           | `agboss_execution_history`                                                                 |
| `MongoRateLimitRepository`           | one update pipeline on the key's single document (slots, windows)                                                                                                               | `agboss_rate_limit_slots`, `…_windows`, `…_pauses`                                         |
| `MongoMeshRequestRepository`         | an upsert with `$setOnInsert`                                                                                                                                                   | `agboss_mesh_requests`                                                                     |
| `MongoA2ATaskRepository`             | **a transaction** to accept a message with its task (agbossjs/agboss#824); a status a compare-and-set on its version                                                            | `agboss_a2a_tasks`, `agboss_a2a_messages`                                                  |
| `MongoA2ADirectMessageRepository`    | **a transaction** to accept a message with its id's claim among the tasks' messages (agbossjs/agboss#860); a reply, a takeover, a removal each a compare-and-set on its attempt | `agboss_a2a_direct_messages`, `agboss_a2a_messages`                                        |

**A2A tasks are shared** (agbossjs/agboss#824). `MongoA2ATaskRepository` keeps the tasks an
application serves over A2A on the replica set: the same `messageId` sent to two pods at once starts
one execution and both answer the same task; `GetTask` and `ListTasks` read any pod's tasks. An
application that serves A2A on `MongoExecutionLeaseRepository` without it does not assemble
(`[a2a.task-store-not-shared]`): each pod's in-memory default would run a resent message again.

**Direct replies are shared** (agbossjs/agboss#860). A skill exposed with `reply: A2AReply.Message`
answers with a `Message`, no task; `MongoA2ADirectMessageRepository` keeps its replies for
`retention.a2aMessages` (default 15 minutes): a resend to any pod gets the same reply, a concurrent
one waits for it, the skill runs once. Each message's id is claimed in `agboss_a2a_messages`, the
task store's messages, as a claim of no task (`taskId` `""`), in the same transaction as its
document — so a task message and a direct message never share an id. List it beside
`MongoA2ATaskRepository`; without it an application exposing a direct-reply skill does not
assemble (`[a2a.message-store-not-shared]`).

**One backend.** The lease, fenced-effect and outbound-call stores declare
`static store = { backend: "mongodb" }` (agbossjs/agboss#526, #825): list the three together. A
component injects the application's `Idempotency` (agbossjs/agboss#1317: never this store's class
— the store is the application's, listed in its `providers`). `runOnce`'s `execute` is handed no
transaction: a repository writes through the connection's `requireTransaction()` — this transaction,
`{ session, db }`, rolled back with the effect on any uncaught error — and writes its business
documents **with the session**; a write without it is outside the guarantee:

<!-- snippet-context
import { Idempotency } from "@agboss/core";
import { hours } from "@agboss/core/units";
import type { MongoConnection } from "@agboss/mongodb";
declare const idempotency: Idempotency;
declare const connection: MongoConnection;
declare const orderId: string;
declare const amount: number;
-->

```ts
await idempotency.runOnce({
  name: "charge",
  ttl: hours(24),
  execute: async () => {
    const { db, session } = connection.requireTransaction();
    await db.collection("charges").insertOne({ orderId, amount }, { session });
    return { receipt: orderId };
  },
});
```

`requireMongoTransaction()` gives the same transaction to a repository that holds no connection of
its own. Every result, every scope's mark and every business key's lock carries the `expiresAt` its
`ttl` set (a scope's mark keeps the latest of its keys, never before a key that never expires); the
recovery sweep's `deleteExpired(now)` removes what is due.

**The marks of a tree are fields of its lease document** (agbossjs/agboss#1341): the cancel
(`cancelRequestedAt`), the stop (`stopRequestedAt`, `stopMode`), the external pause
(`isExternallyPaused`, `externalPauseReason`, `externalPauseMode`) and the fence an `Immediate` pause
raises (`fencedThroughToken`). Each is ONE update the server runs on the document as it is — an
update pipeline, monotone in the update itself: a stop's and a pause's mode only escalate
(`immediate` stays `immediate` whichever of two concurrent requests arrives last), the fence only
rises (`$max`) and is never cleared, the cancel is never unset, the first request's time is kept. A
mark that carries a thread's status entry writes both in one transaction
(`agboss_thread_status_transitions`); a standalone `mongod` without transactions fails closed at
start. The fenced stores read the marks from the tree's ROOT document, a child's key too:
`ExecutionError.CancelFenced` (and the pause and stop refusals the holder reads as such). The lease
store also mirrors a cluster's lease (`syncClusterLease`, `endClusterLease`, `mirroredLeaseOf`): the
document is the authority.

## 2. The driver's options

The connection reads its settings from the application's `@DatabaseStorage` and nowhere else — no
environment field (agbossjs/agboss#1324: the environment is no source of a connection any more). A
script or a test builds one from a settings object: `new MongoConnection({ url, database?, … })`.

```ts
import { secret } from "@agboss/core";
import { SchemaSetup } from "@agboss/core/stores";
import { sec } from "@agboss/core/units";
import { MongoDriver, MongoTransactionReadConcern } from "@agboss/mongodb";

export const driver = MongoDriver({
  url: secret("MONGODB_URL"), // mongodb://h1,h2,h3/<database>?replicaSet=rs0, read once at start, never printed
  database: "desk", // or env("MONGODB_DATABASE"), read once at start; default: the URL's database, else "agboss"
  transactionReadConcern: MongoTransactionReadConcern.Snapshot, // Snapshot (default) or Majority
  schemaSetup: SchemaSetup.Check, // SchemaSetup.Check (default) or SchemaSetup.MigrateOnStart
  timeouts: { watchLiveness: sec(10) }, // the longest a silently dead change stream goes unnoticed: 10 s (default), 2 to 3600 s
});
```

`MongoConnection` holds one `MongoClient` per application instance. At start (`onInit`) it requires
a replica set or a sharded cluster (`requireSupportedTopology()`; `topology()` only reports it),
then checks the schema. A failed start closes the client; the next `onInit` tries again.

## 3. The schema: versioned, migrated explicitly

The stores' collections (with the **simple collation**), their indexes and the ledger's pruning mark
are the schema, version 1 (the 0.1.1 baseline, agbossjs/agboss#1321c: 0.1.0's versions 1-4 squashed;
no 0.1.0 database is migrated), recorded in `agboss_schema` (`{ _id: "agboss", version }`,
agbossjs/agboss#891). It is migrated explicitly, like `@agboss/postgres`'s.

**An upgrade that changes the schema is: stop every instance of the old version, run `migrate`, start
the new version** (agbossjs/agboss#1104, ADR-0034). There is no rolling upgrade across a schema
change in 0.1.x: an old instance that keeps running after the migration writes documents the new
schema's guarantees do not cover — a lease and a fence that never read the cancel mark of #909, a
pause with no `channel`, a lease's token under the 0.1.0 name `leaseEpoch` (#847). So a pre-upgrade
hook that runs the Job while the old pods serve (a Helm `pre-upgrade`, an Argo CD `PreSync`) is right
only for an upgrade that changes no schema — `migrate` printing `nothing to apply`. Otherwise scale
the old version to zero, run the Job, then deploy the new version.

```sh
npx agboss-mongodb migrate [--database <name>] [--allow-live-leases]   # with MONGODB_URL set in the environment (a Secret in the Job); the database: --database, else MONGODB_DATABASE, else the URL's, else agboss
# applied 0001_baseline_0_1_1 (agboss) — a second run: nothing to apply: agboss is at version 1
```

or `migrateMongodb({ url, database?, allowLiveLeases?, signal? })` from a script. `--url <url>` works
too, but puts the URL — its credentials — in the process list and shell history: prefer
`MONGODB_URL`. No output or error of the command prints the URL. Idempotent: concurrent runs end in
one schema, a run after them applies nothing; exit code 0 when current, 1 when the run failed, 2 for
a wrong command line.

**`migrate` refuses while an execution lease is live.** With migrations pending on an already
migrated database, a lease that is not released, finished or superseded and expires after the
**server's** clock (`$$NOW`) means an old instance is still running work: nothing is applied and
`MongoLiveLeasesError` (`mongodb.live-leases`: `count`, up to 5 sorted `holders`) is thrown, exit
code 1. Stop the old instances, let their leases lapse and run again — or pass
`--allow-live-leases` / `allowLiveLeases: true` when you know none runs. A database already at this
version stays a no-op with exit 0 whatever is live. **The blind spot:** an idle old instance holds no
lease, so the guard does not see it — stopping every old instance is still on you. As a backstop for
that blind spot, a channel-filtered page of pauses gives a pause with no `channel` (written by an
old instance after the migration) its channel from its record before it reads.

A start (`SchemaSetup.Check`, the default — `SchemaSetup` is the core's, shared with
`@agboss/postgres`, re-exported here) creates nothing, so the application's pods need no right to
change the schema: a database never migrated, an older one or one a stores' collection was dropped
from is `MongoSchemaMissingError` (`applied`, `expected`, `collections`), one a newer
`@agboss/mongodb` migrated `MongoSchemaTooNewError` (deploy that version: migrations are not rolled
back). The driver's `schemaSetup: SchemaSetup.MigrateOnStart` makes each start migrate first instead, and
is held to the same rule as `migrate` (agbossjs/agboss#1104, #1260): with migrations pending on an
already migrated database the start waits for live leases to lapse (twice the longest lease the
database shows, so a lease duration longer than the default 30 s is waited for too: at least a
minute, at most ten, polled each second on the application's `Clock`, a lease being live or not by the **server's**
clock) — a
stopped single instance's own leases do — and if one is still live it fails to start with
`MongoLiveLeasesError`: stop the old pods first. Nothing pending, no look: a normal restart, a
database at this version and a first start on an empty database are unaffected. A connection built
without a `Clock` (a script: `new MongoConnection({ url })`) has nothing to wait on and refuses at once, as `migrate` does.
`allowLiveLeases: true` in the connection's settings
(`new MongoConnection({ url, schemaSetup: SchemaSetup.MigrateOnStart, allowLiveLeases: true })`)
migrates over live leases, for an operator who accepts the risk.

## Required database settings

The connection refuses to start on anything weaker — each with a named error, each tested:

| Setting                | Required                                                            | Otherwise                                                                |
| ---------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Deployment             | a replica set (one node for development) or a sharded cluster       | `MongoDeploymentError` (`mongodb.deployment-unsupported`)                |
| Write concern          | `w=majority`, `journal=true` (set by the connection)                | `MongoDurabilityError` for `w=1`, `w=0`, `w=<n>`, a tag, `journal=false` |
| Read concern           | `majority` outside transactions; `snapshot` (or `majority`) in them | `MongoDurabilityError` for `local`, `available`                          |
| Read preference        | `primary`                                                           | `MongoDurabilityError`                                                   |
| Retryable writes       | on (the driver's default; set by the connection)                    | `MongoDurabilityError` for `retryWrites=false`                           |
| The stores' collations | simple (binary): `Zoë-17`, `Zoe-17` and `zoe-17` are three keys     | `MongoCollationNotSimpleError` naming the collection                     |

Why: a write acknowledged by fewer than a majority is rolled back when the primary fails over —
an epoch could go back and two workers would own one tree (shown by `tests/integration/failover.test.ts`);
a read below `majority`, or from a secondary, can see a write that is later rolled back. A weaker
option in the URL is refused, never silently overridden.

**The ledger's pruning mark** (agbossjs/agboss#771, #798) is the document `"\u0000pruned-before"` of
`agboss_cost_entries`, made with the collection in one transaction. Keep it when you prune or empty that
collection by hand: without it a save cannot tell an entry the ledger pruned from a new one, so
(or with a `prunedBefore` that is no date) every save and prune fails closed with `MongoLedgerMarkMissingError` (`mongodb.ledger-mark-missing`)
— nothing counted, nothing deleted — and a restart does not seed it again. The error's message is
the remedy: put it back with a mark no lower than any prune's cutoff (`now − retention.costLedgerEntries`).
**Dropping** `agboss_cost_entries` loses its entries with the mark (agbossjs/agboss#832): a start that
makes it again while `agboss_cost_counters` holds spend writes no date — its mark says when it was made
again (`recreatedAt`) — so every save and prune fails closed the same way, and the message names that
time as the mark to put back (an entry made before it is refused, never counted again). Only a
database with no counters starts at the epoch, "never pruned".

### What MongoDB itself must give

- **Time.** A lease's expiry is decided by the server's `$$NOW` inside each command (agbossjs/agboss
  #533), never by a pod's clock. After a failover the new primary's clock decides: keep the members'
  clocks synchronized (NTP), well inside the holder's 1 s safety margin.
- **Transactions** (`transactionLifetimeLimitSeconds`, 60 s by default): a fenced effect's work
  runs inside one; keep it short — store a receipt, not a document.
- **A long fenced work can cost the tree its lease** (agbossjs/agboss#1334): a fenced effect's
  transaction writes the tree's lease document, a child's its root's, so a root lease renewal (a
  single-document write) sent while a fenced `work` is open waits for it. The core bounds a
  background or checkpoint renewal at 5 s as an ordinary store error, never a hand-over; the holder
  survives two failed ticks in a row (a tick every 7.5 s of a 30 s lease, 29 s trusted after the last
  confirmed renewal). A `work`, the root's or any child's, that blocks the renewals for about three
  ticks (roughly 20 s or more) costs the tree its lease: the holder stops at its fence and the tree
  is recovered after the lease lapses. Safety holds, every fence stands; what is lost is liveness. A
  leased call that waits on the same document (`fence.renewNow()`, a write of the root's own under
  its lease) hands the tree over at the time the holder still trusts its lease: MongoDB has no
  command-timeout option. `transactionLifetimeLimitSeconds` aborts a work after 60 s. Do the slow
  part of a step outside the work.
- **A pod killed mid-transaction** (`kill -9`, an OOM kill, a lost node; agbossjs/agboss#1103): the
  transaction it had open stays open on the server and keeps the documents it wrote locked, so
  another instance's change of the same pause (or lease, or key) conflicts and is retried until the
  server aborts the orphaned transaction — after `transactionLifetimeLimitSeconds`, 60 s by
  default. That pause is blocked for about that long; nothing is lost and nothing half-written is
  ever seen, because the dead pod's transaction never committed. There is nothing to clean up by
  hand, and no reason to raise the limit to avoid it.
- **Sharded clusters** are accepted by the start check; the tests and the fault suite run on a
  replica set only.

## Semantics per operation

- **A read in a MongoDB transaction does not lock.** So every fence check is a **write**: the lease
  document is touched first (`checkedAt` — the server's time of the check — and a counter, so the
  update is never a no-op), then read. A take, a renewal or a close of that lease committed after
  the transaction's snapshot makes the touch conflict; one not yet made waits for the transaction.
  A business key (#508) is locked the same way (`agboss_fenced_key_locks`), **before** the work
  runs, because no lease serializes two executions on one key.
- **An attempt's times are the server's** (agbossjs/agboss#658): `saveIfAbsent` writes the first
  attempt's `attemptStartedAt` and `firstAttemptStartedAt`, `markPending` each next
  `attemptStartedAt`, and every `findByKey` answers its record with `readAt` — all the `checkedAt`
  the fence wrote on the lease it locked (`$$NOW`), never a pod's wall clock. So
  `lookup.attemptStartedAt`, `lookup.keyAge` and a `NotSentTrust.KeyReplay`'s `keyRetention` mean
  the same on every pod and after a takeover. An intent written before has none: its key's age is
  unknown, and a `KeyReplay` refuses its replay.
- **A write whose outcome is unknown** (agbossjs/agboss#1017, `src/connection/outcome.ts`) is read by
  whitelist: every single-command write of every store outside a transaction (not only a lease's),
  and every transaction's commit. A write inside a transaction is left as it is: its commit decides.
  Only an error that proves the write was not applied is known and rethrown as it is; every other
  one is `StoreError.OutcomeUnknown` (source `Transport`), and under a lease the holder hands the tree
  over. The client's `socketTimeoutMS` is forced to 300 s.
  - Known server codes: 2, 9, 14 and 40 (refusals of a command's form), for every write; and 112,
    121, 11000, 11001 and 12582 (a write conflict, a validation failure, duplicate keys), the
    replies about one document, for a write of one document.
  - The per-document replies of `updateMany` and `deleteMany` (112, 121, 11000, 11001, 12582) are
    unknown: such a write is not atomic outside a transaction, the documents before the failing one
    stay written. Only 2, 9, 14 and 40 are known for them.
  - A bulk write is known only when every per-operation error is a known code, none of its
    operations was applied, and it met no write concern error.
  - Every commit error is unknown, whatever it says (`NoSuchTransaction`, a transient label, a
    transport or write concern error): the driver retries a commit itself, so the error seen is the
    last attempt's and the first may have committed.
  - Unknown too: a transport error or timeout, a pool or selection error, a write concern error,
    `NotWritablePrimary` and every other code, an error with no code. A read is never classified.
- **Retries.** `MongoConnection.inTransaction` is the driver's `withTransaction`:
  - a `TransientTransactionError` (a write conflict, a step-down) aborts the attempt — none of its
    writes is ever seen — and runs it again from the start: a fenced effect's work can run more than
    once per call and must do nothing outside its session;
  - a commit of unknown outcome (`UnknownTransactionCommitResult`) is committed again, never run
    again;
  - past 120 s, or on an error without either label, the call rejects — and the transaction may
    have committed: the next call on the key replays what it stored (tested).
  - A single-document write (`acquire`, `renew`, `claimExecutionId`, …) is a retryable
    write: one whose reply was lost is retried once, and the server answers the first outcome — no
    epoch counted twice, no id told `false` for its own insert (tested with the server's fail points).
- **One instance's calls on one lease or business key** run in the order they were made: MongoDB's
  transactions take no lock they wait on, so the instance queues them itself, and the first called
  is the first to commit — as PostgreSQL's row locks do.
- **Order.** What is read "in the order appended" (records, the audit log, outbound calls, pauses,
  pending writes) is ordered by a sequence document's `$inc`, never by a client clock or an
  `ObjectId` (agbossjs/agboss#661, #682).
- **A child queued by one pod wakes the others** (agbossjs/agboss#777): the child queue's
  `watchQueued` is a change stream on `agboss_child_execution_queue` — each document that becomes
  `queued` (inserted, or a resume's or a lost claim's requeue) wakes the claimers of every instance,
  so an idle pod claims at once instead of at its next sweep (30 s). One stream per instance, on a
  client of its own with one connection; idle on an empty queue except one held `getMore` per 2.5 s
  (`maxAwaitTimeMS`, no document read) and one `ping` per 5 s. It starts
  just after the cluster time of a `ping` sent before it opens (a stream's start is inclusive, so
  one tick past it), so a child queued once the watch is open is not missed, and one queued before
  does not wake it (agbossjs/agboss#1028). The driver resumes it after a resumable error; one the
  server ends (an `invalidate`) is opened again after a pause (1 s, doubling up to 30 s), past the
  invalidate, and wakes the claimers exactly once — as the PostgreSQL and Redis stores do. A lost
  wake-up costs at most a sweep — the child stays queued.
- **A connection that dies silently** (agbossjs/agboss#789) — a half-open TCP connection behind a
  NAT or a load balancer: no FIN, no RST; the driver alone takes about 40 s to see it, longer than
  the sweep — is noticed within `mongodbWatchLivenessSeconds` (default 10 s, 2 to 3600). The watch
  pings the server every half of it over its one connection — the stream's `getMore`s and the ping
  take turns on it, so an answered ping proves the connection the stream listens on — and the answer
  is due within the other half. A client that does not answer is dropped,
  `child-queue.watch-connection-lost` is logged at `warn`, and the stream is opened on a new client
  after the first pause (1 s), waking the claimers once: a child queued during the gap waits for
  neither the sweep nor the next change. The worst case is the bound, plus 1 s, plus a connection
  (a new client that is swallowed too is dropped at the bound and tried again, 2 s later, doubling
  up to 30 s). The watch's client gives up on a connection that is not up within half the bound,
  waits at most the bound for a reply, and checks the server every quarter of it, so a client
  dropped as silent ends by itself within about the bound, not the driver's 30 s timeouts. After
  `close()` and `MongoConnection.onDestroy()` nothing the watch opened keeps the process alive past
  twice the bound (agbossjs/agboss#1027). `close()` returns only after every cursor it knows of is
  killed on the server: it waits, within the bound, for a stream's `aggregate` in flight to be
  answered, and kills the stream's cursors by id, whatever its own close did (agbossjs/agboss#1345); a cursor
  whose `aggregate` gets no answer within the liveness bound is left to the server's cursor timeout,
  10 minutes by default.
- **Text.** BSON keeps every text as given, U+0000 included. A composite key is the JSON array of
  its parts, so a separator inside a tenant id cannot join two keys, and a lone surrogate (which the
  driver would write as U+FFFD) is escaped in it.

## Pauses (agbossjs/agboss#1307)

`MongoPausedExecutionRepository` keeps one document per pause: the record as JSON text (`record`, the
chain of custody, the question, `firstAskedAt`, `maxExpiresAt`, `escalationLimits`) and, beside it,
the fields the scans and the listings read — `status`, `isSent`, the deadline (`expiresAt`,
`remindAt`, `expiryBound`, BSON Dates; `null` when the pause has none), `target`, and the listing
fields `assignees`, `externalRef` and `channel` (absent when the pause has none, never `null`).

- **A change is one transaction over the pause as it was read**: the document is read, the core's
  rule decides, and one conditional write records it — its filter holds the deadline (open at `at`,
  or due) and, for a deadline change, the deadline the caller read — with the notices appended in the
  same transaction. A concurrent writer of the document makes the write conflict and the transaction
  run again over what it wrote: of two racing changes exactly one applies.
- **`seen`.** `decide…` (required), `resolve…` (optional), `reassign…` and `changeTimeout…` apply
  only while the pause is still the one the caller read and was permitted over (`seenOf`: trail
  length, assignees, deadline, `isSent`), compared with the core's `isSeenAs` on the record read in
  the transaction. `decide…` applies only while the deadline is ahead (the filter).
- **Limits are the record's own.** The counts (`escalationLimits.maxExtensions`,
  `maxReassignments`) and the cap (`maxExpiresAt`) come from the record read in the transaction —
  never from the change, never from configuration. A move to another target narrows them with the
  core's `narrowedLimits` over that same read, in the same write as the replacement's insert; a
  deadline a change sets must be at or before the cap, and is refused when none is given while a cap
  is set. Every time of a pause is a `Date` in memory (`firstAskedAt`, `maxExpiresAt`, the chain's
  `at`, a notice's times) and compared by instant, never as text or with `===`; in the record JSON it
  is the canonical `toISOString()` text and is read back in that one spelling only (any other is
  `StoreError.UnreadableRecord`, naming the field).
- **Dates in the fields a query reads.** `expiresAt`, `remindAt`, `resolvedAt` and a replacement's
  `askedAt` of a pause document, `headWrittenAt`, `nextAttemptAt`, `claimedUntil` and every notice's
  `writtenAt` of a mailbox, and the answer log's `askedAt` are BSON Dates in every document: BSON
  orders by type, so one text among them would sort apart and a `$lte: Date` would never match it.
  The scans' indexes are partial on `$type: "date"`, and a document with a text in such a field is
  refused when read (`StoreError.UnreadableRecord`), not skipped quietly. An Invalid `Date` handed to
  any write or scan is refused first (`StoreError.UnreadableRecord` naming the field), nothing written.
- **A deadline may be taken away** (`expiresAt: null`, `remindAt: null` in the document): the
  deadline indexes are partial on `$type: "date"`, so such a pause is in none of them.
- **Listing.** `findPageByTenantId` and `findPageOfAllTenants` (every tenant's, no tenant clause,
  the same keyset) filter `statuses`, `target`, `expiresBefore`, `channel`, `assignee` (a member of
  the pool: `{ assignees: value }` matches an element) and `externalRef`, in insertion order. Indexes:
  `by_status`, `by_channel`, `by_assignee` (multikey) and `by_external_ref` (partial: only pauses
  that have a reference).
- **A timeout-changed notice** keeps the change's own `actor` and `changeReason` in its mailbox.

**Upgrading.** Documents written before this version are unreadable (`StoreError.UnreadableRecord`,
fail closed): a pause with no `firstAskedAt` or `escalationLimits` — filling them would loosen the
limits its target had, so a rewrite is the operator's decision, not an automatic one — and a
component whose `kind` is `question` or `reply-interpreter` (renamed `external-task` and
`channel-interpreter`; no legacy reader). Drain the open pauses before the upgrade or rewrite them
by hand. The new indexes are made by `agboss-mongodb migrate`, which is idempotent: run it against a
database already at version 1 (the baseline of 0.1.1, still unreleased, gained them) too.

## Tests

```sh
npm ci && npm run pack:framework && npm run install:packed   # the core at the pinned SHA
npm run check                                                # the gate CI runs
npm run test:faults                                          # the fault suite (CI: 3 shards)
```

Every test needs a real replica set of **three** members started with `--setParameter
enableTestCommands=1` (`AGBOSS_MONGODB_TEST_URL`: the failover and retry tests force errors with the
server's fail points and step its primary down), and a standalone `mongod`
(`AGBOSS_MONGODB_STANDALONE_TEST_URL`). Without them the run fails, never skips. Locally, three
containers sharing one network namespace, so the members' `localhost:<port>` names work from the
host too:

```sh
docker network create agboss-mongo
docker run -d --name agboss-mongo-rs1 --network agboss-mongo --cpus 0.5 --memory 512m \
  -p 127.0.0.1:57017-57020:57017-57020 mongo:7 mongod --replSet rs0 --port 57017 --bind_ip_all \
  --wiredTigerCacheSizeGB 0.25 --setParameter enableTestCommands=1
for i in 2 3; do docker run -d --name agboss-mongo-rs$i --network container:agboss-mongo-rs1 \
  --cpus 0.5 --memory 512m mongo:7 mongod --replSet rs0 --port 5701$((6 + i)) --bind_ip_all \
  --wiredTigerCacheSizeGB 0.25 --setParameter enableTestCommands=1; done
docker exec agboss-mongo-rs1 mongosh --port 57017 --eval 'rs.initiate({_id:"rs0",members:[
  {_id:0,host:"localhost:57017",priority:2},{_id:1,host:"localhost:57018"},{_id:2,host:"localhost:57019"}]})'
export AGBOSS_MONGODB_TEST_URL='mongodb://localhost:57017,localhost:57018,localhost:57019/?replicaSet=rs0'
```

What runs:

- `tests/contracts/store-conformance.test.ts` — every store through the core's `storeConformance`,
  nothing left out, the interleaving explorer included.
- `tests/contracts/sabotage.test.ts` — broken stores must fail it: leases on the caller's clock, a
  check-then-write `acquire`, a fence check that only reads.
- `tests/integration/failover.test.ts` — a lease written at `w=1` is lost by a failover (two
  owners); at `w=majority` there is one.
- `tests/integration/retries.test.ts` — transient errors, unknown commit results, lost replies.
- `tests/faults/` — the core's fault suite: real pods killed, stopped, frozen and cut off the
  primary by a proxy each (a direct connection through it), the store history checked for
  linearizability; then the core's sabotages, each passing only when it charges twice
  (agbossjs/agboss#831). CI shards it (`AGBOSS_FAULT_SHARD=k/3`, read by the suite).

## Releasing

`@agboss/mongodb` is published right after `@agboss/core`, by the maintainer only: a release pins the
published core (`node scripts/pin-framework.mjs --registry X.Y.Z`, `.agboss-version.json`
`source: "registry"` — `npm run pack:framework` then downloads the registry's tarballs and checks
their integrity), and a pushed tag `mongodb-vX.Y.Z` runs `.github/workflows/release.yml`, which
publishes with provenance only when the tag is the package's version, the commit is on `main` and
its CI passed. A pull request touching the release path runs the workflow's dry run
(`npm publish --dry-run`). See [CONTRIBUTING.md](CONTRIBUTING.md) → Releasing.

### Upgrading across the token rename (agbossjs/agboss#847)

A lease document stores its fencing token as `token`; one a pre-0.1.1 build wrote names it
`leaseEpoch`, and is still read by that token (renewed, fenced, retired and taken over as before),
then stored as `token` by its next write. A pre-0.1.1 build cannot read `token`: upgrade every
instance on the replica set together — there is no rolling upgrade across the rename.

## License

Apache-2.0, as the core. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
