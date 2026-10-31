# @agboss/mongodb

MongoDB stores for [AGBoss](https://github.com/agbossjs/agboss): several application instances —
each its own process, no shared disk — will share execution trees on one MongoDB replica set, with
the same double-charge and dead-worker guarantees as
[`@agboss/postgres`](https://github.com/agbossjs/postgres).

> **Status: scaffold.** The connection and its start checks are here and tested against a real
> replica set in CI. The stores are pending the core's store conformance
> ([agbossjs/agboss#526](https://github.com/agbossjs/agboss/issues/526)) and fault suite
> ([#484](https://github.com/agbossjs/agboss/issues/484)); the plan is
> [#527](https://github.com/agbossjs/agboss/issues/527). Not published to npm yet.

## What it will provide

Every store contract of the core, on one replica set — an application runs on MongoDB alone, as it
does on PostgreSQL:

| Contract                                                | How it maps to MongoDB                                    |
| ------------------------------------------------------- | --------------------------------------------------------- |
| Execution leases (who moves a tree, fenced by epoch)    | `findOneAndUpdate` with the epoch in the filter           |
| Fenced effects and outbound calls                       | the lease check and the business write in one transaction |
| The lease log                                           | in the lease's transaction                                |
| Records, trees, pauses, the child queue, checkpoints    | conditional single-document writes, unique indexes        |
| Cost ledger, execution history, rate limits, mesh dedup | `$inc` / conditional updates, unique keys                 |

Every store will run `storeConformance` (#526) and the fault suite (#484) against a real replica
set in CI. The fenced effect and the outbound call share the lease store's deployment: #526's
assembly check refuses a lease store on one backend and a fenced-effect store on another.

## Required database settings

The connection refuses to start on anything weaker — each with a named error, each tested:

| Setting                              | Required                                                                           | Otherwise                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Deployment                           | a replica set (one node is enough) or a sharded cluster                            | `MongoReplicaSetRequiredError` at `onInit`                                                        |
| Write concern                        | `w=majority`, `journal=true` (set by the connection)                               | `MongoConcernTooWeakError` when the URL asks for `w=1`, `w=0`, `w=<n>`, a tag, or `journal=false` |
| Read concern (outside a transaction) | `majority` (set by the connection; `snapshot`, `linearizable` in the URL accepted) | `MongoConcernTooWeakError` for `local`, `available`                                               |
| Read concern of a transaction        | `snapshot` (default) or `majority` (`mongodbTransactionReadConcern`)               | `MongoSettingsError` for any other value                                                          |
| Read preference                      | `primary`                                                                          | `MongoConcernTooWeakError` for any other mode                                                     |

A weaker option in the URL is refused, never silently overridden: the operator who wrote `w=1`
learns it does not hold. Why each matters: a write acknowledged by fewer than a majority is rolled
back when the primary fails over — a lease's epoch could go back and two workers would both own a
tree; a read below `majority`, or from a secondary, can see a write that is later rolled back or
miss one that was made.

For development, a single-node replica set:

```sh
docker run -d --name agboss-mongodb -p 27017:27017 mongo:7 --replSet rs0 --bind_ip_all
docker exec agboss-mongodb mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'
```

## The connection

```ts
import { Secret } from "@agboss/core";

export class AppEnvironment {
  mongodbUrl!: Secret; // mongodb://h1,h2,h3/?replicaSet=rs0 — secret("MONGODB_URL")
  mongodbDatabase?: string; // default "agboss"
  mongodbTransactionReadConcern?: string; // "snapshot" (default) or "majority"
}
```

`MongoConnection` (`deps: [ApplicationContext]`, or `new MongoConnection({ url })` in a script or a
test) holds one `MongoClient` per application instance. `inTransaction(work)` runs `work` in a
session transaction with the chosen read concern and a `w=majority` commit; the driver retries it on
a transient error, so `work` must be safe to run again. `onDestroy` closes the client.

## Tests

```sh
npm ci && npm run pack:framework && npm run install:packed   # the core at the pinned SHA
npm run check                                                # the gate CI runs
```

The unit tests (settings, concerns, the `hello` check, the connection's construction) run anywhere.
The integration tests need a real replica set (`AGBOSS_MONGODB_TEST_URL`) and a standalone `mongod`
(`AGBOSS_MONGODB_STANDALONE_TEST_URL`); without them they are skipped locally with a notice, and
fail in CI, which starts both (`mongo:7`).

## License

Apache-2.0, as the core. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
