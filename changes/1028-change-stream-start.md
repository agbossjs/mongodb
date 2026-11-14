---
section: Fixed
issue: 1028
---

**The child queue's change stream starts strictly after what the watch has seen** (agbossjs/agboss#1028) — a new stream began at the cluster time of its `ping`, which is inclusive, so it replayed the last write: a reopen woke the claimers twice, an open woke them for a child queued before it, and after an `invalidate` (the queue collection dropped or renamed) the watch reopened onto the same invalidate until some later write moved the cluster time on. The stream now starts one tick after the ping's time: a reopen wakes exactly once, as the PostgreSQL and Redis stores do, and an open wakes nobody for an earlier write. Fixes the flaky `queue-watch.test.ts` (the issue's AC4).
