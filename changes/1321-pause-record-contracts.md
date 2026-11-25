---
section: Breaking
issue: 1321
---

**The pause and record stores follow the core's `main` contracts** (agbossjs/agboss#1321, #1307, #1310, #1341b): a pause is found by its `target` (`PauseFilter.target`; each pause document copies `target`, the `by_tenant` index is `(tenantId, status, target, seq)`), is reassigned in place or to a replacement through `PauseReassignmentChange` (a pool of `assignees`, a `reassigned` chain-of-custody entry, `seen`, `due`, `timeout`, `to`, `maxReassignments` / `maxExtensions`, each checked in the transaction of the write) and extended with a `timeout-changed` entry under `maxExtensions`; `markSent…` takes the channel's `externalRef`; a change of the chain of custody rewrites the pause's record; a `reassigned` notice carries what moved, its assignees included. `completeUnlessInterrupted` writes a finish only while its tree's lease document carries no stop or cancel mark, read after a write to that document in the finish's own transaction. The 0.1.0 readers are gone with their migration: a pause without `kind` is refused, the `channel` backfill (`fillMissingChannels`) does not exist. No migration: the baseline changed.
