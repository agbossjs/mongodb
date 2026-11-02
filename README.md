# @agboss/mongodb

MongoDB stores for [AGBoss](https://github.com/agbossjs/agboss): several application instances —
each its own process, no shared disk — share execution trees on one MongoDB **replica set**, with
the same guarantees as [`@agboss/postgres`](https://github.com/agbossjs/postgres). A pod that dies
mid-run is taken over by another from its last checkpoint; a zombie that wakes up can no longer
write (every fenced write carries its lease's epoch); a charge, a booking or a mail is made once per
key; a call that leaves the system is recorded before it is sent and reconciled, never sent again
blindly. Budgets, rate limits, history and mesh deduplication are shared by every pod.

> Status: every store contract of the core — leases, execution ids, records and threads, trees,
> pauses, the child queue, checkpoints, the fenced effect with business keys, the lease log, the
> cost ledger, the execution history, rate limits, mesh requests and outbound calls. Each passes the
> core's `storeConformance` (the interleaving explorer included) and the fault suite against a real
> replica set ([Tests](#tests)). Not published to npm yet.

## Install

```sh
npm install @agboss/mongodb
```

Peer dependencies: `@agboss/core` `^0.1.1`, `@langchain/core`, `@langchain/langgraph-checkpoint`.
Dependencies: the official `mongodb` driver (7.x), `zod`.

## 1. List the stores

```ts no-check: needs the package's build
import { Application } from "@agboss/core";
import {
  MongoCheckpointSaver,
  MongoChildExecutionQueueRepository,
  MongoCostLedgerRepository,
  MongoExecutionHistoryRepository,
  MongoExecutionLeaseEventRepository,
  MongoExecutionLeaseRepository,
  MongoExecutionRecordRepository,
  MongoExecutionTreeRepository,
  MongoFencedEffectRepository,
  MongoMeshRequestRepository,
  MongoOutboundCallRepository,
  MongoPausedExecutionRepository,
  MongoRateLimitRepository,
} from "@agboss/mongodb";

@Application({
  name: "desk",
  version: "1.0.0",
  environment: AppEnvironment,
  workflows: [DeskWorkflow],
  providers: [
    MongoCheckpointSaver,
    MongoChildExecutionQueueRepository,
    MongoCostLedgerRepository,
    MongoExecutionHistoryRepository,
    MongoExecutionLeaseEventRepository,
    MongoExecutionLeaseRepository, // who moves a tree, fenced by epoch
    MongoExecutionRecordRepository,
    MongoExecutionTreeRepository,
    MongoFencedEffectRepository, // with MongoExecutionLeaseRepository: one transaction
    MongoMeshRequestRepository,
    MongoOutboundCallRepository, // with MongoExecutionLeaseRepository: one transaction
    MongoPausedExecutionRepository,
    MongoRateLimitRepository,
  ],
})
export class DeskApplication {}
```

| Store                                | How it is atomic                                                                               | Collections                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `MongoExecutionLeaseRepository`      | one conditional single-document command per operation; time `$$NOW`                            | `agboss_execution_leases`, `agboss_execution_ids`                                          |
| `MongoFencedEffectRepository`        | **a transaction**: the lease locked by a write, the mark, the key's lock, the result, the work | `agboss_fenced_effect_marks`, `…_results`, `agboss_fenced_key_locks`                       |
| `MongoOutboundCallRepository`        | **a transaction** per fenced method: the lease and mark, then one compare-and-set              | `agboss_outbound_calls`                                                                    |
| `MongoExecutionLeaseEventRepository` | one insert (an append), ordered by a sequence                                                  | `agboss_execution_lease_events`                                                            |
| `MongoExecutionRecordRepository`     | one command per write; `completeIfStatus` a compare-and-set                                    | `agboss_threads`, `agboss_execution_records`, `…_scores`, `…_summaries`, `…_pause_answers` |
| `MongoExecutionTreeRepository`       | an upsert with `$setOnInsert`                                                                  | `agboss_execution_tree_keys`                                                               |
| `MongoPausedExecutionRepository`     | every move of a pending pause a compare-and-set on its status                                  | `agboss_paused_executions`, `agboss_pauses`                                                |
| `MongoChildExecutionQueueRepository` | a claim is one `findOneAndUpdate`; a save one upsert                                           | `agboss_child_execution_queue`                                                             |
| `MongoCheckpointSaver`               | one replace per checkpoint; a task's writes in one transaction                                 | `agboss_checkpoints`, `agboss_checkpoint_writes`                                           |
| `MongoCostLedgerRepository`          | **a transaction** of `$inc`s: every counter of a save, or none                                 | `agboss_cost_counters`, `agboss_cost_max_spend`                                            |
| `MongoExecutionHistoryRepository`    | a replace with upsert                                                                          | `agboss_execution_history`                                                                 |
| `MongoRateLimitRepository`           | one update pipeline on the key's single document (slots, windows)                              | `agboss_rate_limit_slots`, `…_windows`, `…_pauses`                                         |
| `MongoMeshRequestRepository`         | an upsert with `$setOnInsert`                                                                  | `agboss_mesh_requests`                                                                     |

**One backend.** The lease, fenced-effect and outbound-call stores declare
`static backend = "mongodb"` (agbossjs/agboss#526): list the three together. A fenced effect's work
gets the transaction — `{ session, db }` — and writes its business documents **with the session**;
a write without it is outside the guarantee:

```ts no-check: a fragment of a component
await effects.saveResultIfAbsent(fencedEffectKeyOf(executionContext, "charge"), async ({ db, session }) => {
  await db.collection("charges").insertOne({ orderId, amount }, { session });
  return { receipt: orderId };
});
```

## 2. The environment

```ts no-check: a fragment of an environment contract
export class AppEnvironment {
  mongodbUrl!: Secret; // mongodb://h1,h2,h3/<database>?replicaSet=rs0 — secret("MONGODB_URL")
  mongodbDatabase?: string; // default: the URL's database, else "agboss"
  mongodbTransactionReadConcern?: string; // "snapshot" (default) or "majority"
}
```

`MongoConnection` holds one `MongoClient` per application instance. At start (`onInit`) it requires
a replica set or a sharded cluster, then makes the stores' collections and indexes (idempotent:
every instance runs it, nothing to migrate) with the **simple collation**.

## Required database settings

The connection refuses to start on anything weaker — each with a named error, each tested:

| Setting                | Required                                                            | Otherwise                                                                    |
| ---------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Deployment             | a replica set (one node for development) or a sharded cluster       | `MongoReplicaSetRequiredError`                                               |
| Write concern          | `w=majority`, `journal=true` (set by the connection)                | `MongoConcernTooWeakError` for `w=1`, `w=0`, `w=<n>`, a tag, `journal=false` |
| Read concern           | `majority` outside transactions; `snapshot` (or `majority`) in them | `MongoConcernTooWeakError` for `local`, `available`                          |
| Read preference        | `primary`                                                           | `MongoConcernTooWeakError`                                                   |
| Retryable writes       | on (the driver's default; set by the connection)                    | `MongoConcernTooWeakError` for `retryWrites=false`                           |
| The stores' collations | simple (binary): `Zoë-17`, `Zoe-17` and `zoe-17` are three keys     | `MongoCollationError` naming the collection                                  |

Why: a write acknowledged by fewer than a majority is rolled back when the primary fails over —
an epoch could go back and two workers would own one tree (shown by `tests/integration/failover.test.ts`);
a read below `majority`, or from a secondary, can see a write that is later rolled back. A weaker
option in the URL is refused, never silently overridden.

### What MongoDB itself must give

- **Time.** A lease's expiry is decided by the server's `$$NOW` inside each command (agbossjs/agboss
  #533), never by a pod's clock. After a failover the new primary's clock decides: keep the members'
  clocks synchronized (NTP), well inside the holder's 1 s safety margin.
- **Transactions** (`transactionLifetimeLimitSeconds`, 60 s by default): a fenced effect's work
  runs inside one; keep it short — store a receipt, not a document.
- **Sharded clusters** are accepted by the start check; the tests and the fault suite run on a
  replica set only.

## Semantics per operation

- **A read in a MongoDB transaction does not lock.** So every fence check is a **write**: the lease
  document is touched first (`checkedAt` — the server's time of the check — and a counter, so the
  update is never a no-op), then read. A take, a renewal or a close of that lease committed after
  the transaction's snapshot makes the touch conflict; one not yet made waits for the transaction.
  A business key (#508) is locked the same way (`agboss_fenced_key_locks`), **before** the work
  runs, because no lease serializes two executions on one key.
- **Retries.** `MongoConnection.inTransaction` is the driver's `withTransaction`:
  - a `TransientTransactionError` (a write conflict, a step-down) aborts the attempt — none of its
    writes is ever seen — and runs it again from the start: a fenced effect's work can run more than
    once per call and must do nothing outside its session;
  - a commit of unknown outcome (`UnknownTransactionCommitResult`) is committed again, never run
    again;
  - past 120 s, or on an error without either label, the call rejects — and the transaction may
    have committed: the next call on the key replays what it stored (tested).
  - A single-document write (`acquire`, `renew`, `saveExecutionIdIfAbsent`, …) is a retryable
    write: one whose reply was lost is retried once, and the server answers the first outcome — no
    epoch counted twice, no id told `false` for its own insert (tested with the server's fail points).
- **One instance's calls on one lease or business key** run in the order they were made: MongoDB's
  transactions take no lock they wait on, so the instance queues them itself, and the first called
  is the first to commit — as PostgreSQL's row locks do.
- **Order.** What is read "in the order appended" (records, the lease log, outbound calls, pauses,
  pending writes) is ordered by a sequence document's `$inc`, never by a client clock or an
  `ObjectId` (agbossjs/agboss#661, #682).
- **Text.** BSON keeps every text as given, U+0000 included. A composite key is the JSON array of
  its parts, so a separator inside a tenant id cannot join two keys, and a lone surrogate (which the
  driver would write as U+FFFD) is escaped in it.

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
  linearizability.

## License

Apache-2.0, as the core. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
