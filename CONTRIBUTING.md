# Contributing

`@agboss/mongodb` follows the conveyor of [agbossjs/agboss](https://github.com/agbossjs/agboss):
every change starts as an issue there (stage = its `status:*` label: Triage → Backlog → In progress
→ Test → Done, Done only by a human closing it) and lands here through a squash-merged PR.

## Before a PR

1. `npm ci && npm run pack:framework && npm run install:packed` — the core at the pinned SHA.
2. `npm run check` — the gate CI runs too. The integration tests need a MongoDB replica set and a
   standalone `mongod`; without `AGBOSS_MONGODB_TEST_URL` and `AGBOSS_MONGODB_STANDALONE_TEST_URL`
   they are skipped locally (the run says so) — CI runs them on `mongo:7`. To run them locally,
   start the servers the skip notice names and export the two URLs.

## Branches, commits, PRs

- Branch from `main`: `<type>/<issue>-<slug>` (`chore/527-scaffold`).
- Conventional commits naming the issue: `feat(agbossjs/agboss#527): …`, `fix(…): …`.
- The PR body says `Refs agbossjs/agboss#<issue>`; it is squash-merged when CI is green.
- Labels: `type:feature` · `type:bugfix` · `type:chore` · `prio:mvp` · `blocked`, as the core.

## Releasing

`@agboss/mongodb` is versioned with `@agboss/core` (a peer dependency range) and published right
after it. Before that, `npm run install:published` checks the package against the registry's core.
