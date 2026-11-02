# AGENTS.md — @agboss/mongodb

AGBoss's stores on a MongoDB replica set (agbossjs/agboss#527): several application instances,
each its own process with no shared disk, share execution trees, budgets, history, rate limits, mesh
requests and the calls that leave the system on one replica set. The package implements the core's
infrastructure contracts; it never changes them. Every store passes `storeConformance` (#526, the
interleaving explorer included) and the core's fault suite (#484).

## Stack

TypeScript strict, ESM, Node 22+ · the official `mongodb` driver (one `MongoClient` per application
instance) · zod for every reply and document read back · Vitest + v8 coverage, integration tests
against a real replica set (`AGBOSS_MONGODB_TEST_URL`) · api-extractor (`api/mongodb.api.md`).

## Commands

- `npm run pack:framework && npm run install:packed` — `@agboss/core` and `@agboss/cli` at the SHA
  pinned in `.agboss-version.json` (pin the current agboss `main` when a store needs a newer core).
- `npm run test:faults` — the core's fault suite (CI: three shards, `AGBOSS_FAULT_SHARD=k/n`).
- `npm run check` — format, suppressions (budget 0), reviewed installs (`check:installs`: a
  workflow installs with `npm ci`, a script resolves ranges only with `--before`, three days back —
  agbossjs/agboss#523), no real-time threshold in a test (`check:real-time`), lint, types, tests
  with coverage, API report.

## Architecture

- `src/connection/` — `MongoConnection` (DI token, `deps: [ApplicationContext]`, or
  `new MongoConnection({ url })` in a script/test); its settings from the environment
  (`mongodbUrl: Secret`, `mongodbDatabase`, `mongodbTransactionReadConcern`); the concerns
  (`concerns.ts`: a URL weaker than `w=majority` / `journal` / majority reads / primary is refused
  with `MongoConcernTooWeakError`, never overridden; the client carries the enforced ones); the
  deployment check (`deployment.ts`: `hello` → replica set / sharded / standalone, a standalone is
  `MongoReplicaSetRequiredError`); `inTransaction` (snapshot by default, `w=majority` commit).
- `src/errors.ts` — every named error, an `AGBossError` with a stable `mongodb.*` code.
- `src/connection/schema.ts` — the collections (`collections.ts`) and indexes, made at `onInit`
  with the simple collation; a collection of another collation is `MongoCollationError`.
- `src/stores/` — one store per contract (`Mongo*Repository`, `MongoCheckpointSaver`); every
  atomic operation one conditional single-document command or one transaction, stated in each
  store's doc comment. A lease's expiry is the server's `$$NOW` inside each command
  (`store-time.ts`; a test's clock as a literal when `StoreClock.isDatabaseTime` is false); every
  other time the `Clock`'s. A fence check in a transaction is a **write** to the lease (`fence.ts`:
  a read does not lock); a business key is locked the same way before its work. One instance's
  fenced calls on one key run in call order (`local-order.ts`). "In the order appended" is a
  sequence (`sequence.ts`), never a clock or an `ObjectId`. Composite `_id`s are JSON arrays
  (`keys.ts`).
- `tests/contracts/` — `storeConformance` on every store; `sabotage.test.ts` runs broken stores in
  a nested vitest and expects each to fail. `tests/faults/` — the core's fault suite (a pod reaches
  the primary by a direct connection through its proxy). `tests/integration/` — the connection,
  the schema, the driver's retries (the server's fail points), a failover (`w=1` vs
  `w=majority`). `tests/connection/` — unit tests with fakes.

## Rules

- Import only `@agboss/core` public entries (`@agboss/core`, `/units`, `/testing`,
  `/testing/contracts`, `/eslint`); never `/internal`. When the core lacks a public seam a store
  needs, stop and report it on the issue.
- The core's limits: 200 lines per file, 50 per function, complexity 10; no `eslint-disable`,
  `@ts-ignore`, `as any`, `as unknown as`. Components keep no state (`agboss/no-component-state`),
  time from the `Clock` (`agboss/no-direct-time`).
- Vitest runs at most two workers (`vitest.config.ts`).
- Every test needs a real replica set of three members with `enableTestCommands=1`
  (`AGBOSS_MONGODB_TEST_URL`) and a standalone `mongod` (`AGBOSS_MONGODB_STANDALONE_TEST_URL`):
  without them the run fails, never skips. Never start a server from a test or a script (the
  failover test steps the set's primary down and sets fail points, and heals the set after).
- Every required database setting has a test that fails when it is not met (#527 AC3).
- Conveyor, labels, branches and PRs as agbossjs/agboss (see CONTRIBUTING.md).
