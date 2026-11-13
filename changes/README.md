# Changelog fragments

The same convention as agbossjs/agboss (`changes/README.md` there); `scripts/changelog-assemble.mjs` and `scripts/changelog-fold.mjs` are vendored copies of its scripts (change them there first).

A pull request never edits `CHANGELOG.md` (CI fails it). It adds one file here instead, so two PRs
never conflict on the changelog (agbossjs/agboss#981). At release, `scripts/changelog-assemble.mjs` folds the
fragments into the version's section of `CHANGELOG.md` and deletes them.

## The rule

- Path: `changes/<issue>-<slug>.md`. The issue is the one the PR `Refs` (agbossjs/agboss's numbering; the entry writes `agbossjs/agboss#<issue>`); the slug is lowercase
  words joined by hyphens, so one issue with two entries uses two slugs.
- A header of two keys, then the entry text. `section` is one of `Breaking`, `Changed`, `Added`,
  `Fixed`, `Deprecated`, `Security`; `issue` equals the number in the file name.
- The entry is Markdown, written as it should read in `CHANGELOG.md` (a bold lead, the reason, the
  migration for a breaking change). It must mention `#<issue>`, as `agbossjs/agboss#<issue>` here. Continuation lines are indented by
  the script, so write them flush left.

```markdown
---
section: Fixed
issue: 960
---

**A lease expires by the store's own clock** (agbossjs/agboss#960): the sweep read the clock of the
application host. No migration.
```

## Assembling (the release PR)

```sh
node scripts/changelog-assemble.mjs 0.1.2 --date 2026-12-01
```

The version's section in `CHANGELOG.md` is one of three, and the script handles each:

- **Unreleased** (`## [0.1.2] — unreleased`; the older `## [Unreleased] — 0.1.2 (…)` is read too): each
  fragment goes under the `### <heading>` of its section inside it, after the entries already there;
  a heading that is not there yet is created in the order Breaking (headed `Changed — breaking`),
  Changed, Added, Fixed, Deprecated, Security. Other subheadings (`Fixed — other`, `Docs`, …) stay
  as they are. The heading, in either form, becomes `## [<version>] — <date>`; no PR edits it
  before (CI), so the draft heading stays as it is until the release PR.
- **Absent**: a new dated section is written above the newest release; the file is created if the
  repository has none.
- **Released** (a date in the heading): a fragment that is not in it yet fails the run. Fix the
  version, or put the entry under the next one.

Inside a section, new entries are ordered by issue number. A fragment with an unknown section, a
name that disagrees with its `issue`, or an entry that does not mention its issue fails the run and
changes nothing. With no fragments the run does nothing, so it is safe to repeat. `--check`
validates the fragments without assembling.

`changes/config.json` holds `issuePrefix`, the form an entry mentions its issue in (`"#"` here is
`#<issue>`; `"agbossjs/agboss#"` is the form the satellites use, so a bare `#<issue>` fails there).
It is read, never guessed from the directory name; a `changes/` without it fails the run.

**If a run is interrupted.** `CHANGELOG.md` is written to a temp file and renamed over, so it is
never torn; the fragments are deleted only after. A crash during the deletes leaves some fragments
behind: run the same command again. A fragment whose entry is already in the section is only
deleted, never inserted twice, so the rerun finishes the job (use the same version; the date of the
first run stays). A crash before the rename changes nothing, and the rerun is a first run. A
leftover `.CHANGELOG.md.<pid>.tmp` beside the file is safe to delete.

## The release PR

A PR may edit `CHANGELOG.md` only from a branch named `release/<version>`. Every other PR that
touches `CHANGELOG.md` fails the `changelog-fragments` CI job with a pointer here.
