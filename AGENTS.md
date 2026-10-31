# AGENTS.md — @agboss/mongodb

AGBoss's stores on a MongoDB replica set (agbossjs/agboss#527): several application instances,
each its own process with no shared disk, will share execution trees, budgets, history, rate limits
and mesh requests on one deployment. The package implements the core's infrastructure contracts; it
never changes them. **Status: scaffold** — the connection only; the stores wait for the core's
`storeConformance` (#526) and fault suite (#484). Do not start a store before both are merged.

## Stack

TypeScript strict, ESM, Node 22+ · the official `mongodb` driver (one `MongoClient` per application
instance) · zod for every reply and document read back · Vitest + v8 coverage, integration tests
against a real replica set (`AGBOSS_MONGODB_TEST_URL`) · api-extractor (`api/mongodb.api.md`).

## Commands

- `npm run pack:framework && npm run install:packed` — `@agboss/core` and `@agboss/cli` at the SHA
  pinned in `.agboss-version.json` (pin the current agboss `main` when a store needs a newer core).
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
- `src/stores/` — (pending #526/#484) one store per contract; every atomic operation one
  conditional single-document write or one transaction, stated in each store's doc comment. Time
  only from the `Clock`.
- `tests/connection/` — unit tests with fakes (no server); `tests/integration/` — against a real
  replica set and a standalone `mongod`.

## Rules

- Import only `@agboss/core` public entries (`@agboss/core`, `/units`, `/testing`,
  `/testing/contracts`, `/eslint`); never `/internal`. When the core lacks a public seam a store
  needs, stop and report it on the issue.
- The core's limits: 200 lines per file, 50 per function, complexity 10; no `eslint-disable`,
  `@ts-ignore`, `as any`, `as unknown as`. Components keep no state (`agboss/no-component-state`),
  time from the `Clock` (`agboss/no-direct-time`).
- Vitest runs at most two workers (`vitest.config.ts`).
- Integration tests need a real MongoDB: in CI (`CI` set) a missing URL fails the run; locally they
  are skipped with a notice. Never start a local server from a test or a script.
- Every required database setting has a test that fails when it is not met (#527 AC3).
- Conveyor, labels, branches and PRs as agbossjs/agboss (see CONTRIBUTING.md).
