---
section: Changed
issue: 1064
---

**On the core's pause contract of agbossjs/agboss#942, #1099, #1148 and #941** (agbossjs/agboss#1064):
`extendByTenantIdAndPauseId` takes a `PauseDeadlineChange` and is one compare-and-set over the
deadline the caller read (`previousExpiresAt`) to a later one, while the stored deadline is after the
caller's `at` — the loser, and a write after the deadline, get `undefined` and write nothing;
`findPendingByExpiresAtBefore` and `findPendingByRemindAtBefore` take a keyset `after`
`(at, tenantId, pauseId)`; `renewNotice` renews a notice claim while its receiver runs, only for its
token and while it holds, never earlier than it was (agbossjs/agboss#1131). The checkpoint saver
declares `StoreCapability.LatestByStep`, its ties by code point (agbossjs/agboss#1115: MongoDB's
string order). No migration for these.

**A write whose outcome the driver could not resolve is `StoreOutcomeUnknownError`**
(agbossjs/agboss#1017, #1188) — the driver retries a lost `commitTransaction` and a retryable write
once, and the server answers the retry from its transaction number, so after one reset nothing is
unknown. What is still unknown after that — a commit that keeps `UnknownTransactionCommitResult` or
fails as a transport error, a single-command lease write (`acquire`, `renew`, `release`, `retire`,
`yield`, `reclaim`, `requestCancel`, `claimExecutionId`) that fails as a transport error or a write
concern error — rejects with `StoreOutcomeUnknownError` (source `Transport`): under a lease the holder
hands the tree over and the next one reads what was left. The work of a transaction is never run again
for it, and a commit is no longer sent again until 120 s have passed. The fault suite's MongoDB set
declares `resolvesCommitByRetry` (scenarios 23 and 23b).
