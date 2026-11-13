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
- Changelog: add a fragment `changes/<issue>-<slug>.md` (format: `changes/README.md`); never edit
  `CHANGELOG.md` — CI fails a PR that does, unless its branch is `release/*`.
- Labels: `type:feature` · `type:bugfix` · `type:chore` · `prio:mvp` · `blocked`, as the core.

## Releasing

`@agboss/mongodb` is versioned with `@agboss/core` and published right after it, by the maintainer
only (agbossjs/agboss `RELEASE_CHECKLIST.md` is the ordered list; agbossjs/agboss#691):

1. Once `@agboss/core@X.Y.Z` is on npm, pin it — `node scripts/pin-framework.mjs --registry X.Y.Z`
   (`.agboss-version.json` `source: "registry"`: `npm run pack:framework` then downloads the
   registry's tarballs and checks their integrity) — and bump `package.json` to `X.Y.Z` with the
   peer dependency `^X.Y.Z`, in one PR; its CI runs everything on the published core.
2. After it is merged and `main`'s CI is green, push the tag `mongodb-vX.Y.Z` on that commit.
   `.github/workflows/release.yml` checks the tag, the version, the pin and that CI passed on the
   commit, then publishes with provenance (`NPM_TOKEN` of the `npm` environment).
3. Back to a commit pin for development: `node scripts/pin-framework.mjs --sha <agboss main sha>`.

A pull request that touches the release path runs the workflow's dry run (`npm publish --dry-run`).
