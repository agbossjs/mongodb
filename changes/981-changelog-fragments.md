---
section: Changed
issue: 981
---

**Changelog entries are fragments** (agbossjs/agboss#981): a PR adds `changes/<issue>-<slug>.md`
instead of editing `CHANGELOG.md`, and `scripts/changelog-assemble.mjs` folds them into the release
section (`changes/README.md`). CI fails a PR that edits `CHANGELOG.md` unless its branch is
`release/*`. Nothing for an application using the package.
