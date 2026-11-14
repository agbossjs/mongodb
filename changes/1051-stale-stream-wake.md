---
section: Fixed
issue: 1051
---

**A change stream the child queue's watch dropped as dead no longer wakes it** (agbossjs/agboss#1051) — the stream marked lost was never closed: once connections went through again its driver resumed it, and its change handler woke the claimers for a child queued in the outage, on top of the catch-up wake after the reopen, so a reopen with no later write woke twice (at liveness bounds 2, 4 and 10 alike). The dropped stream and its client are now closed, and every stream's handlers ignore events unless their stream is the current one (a generation token): no wake comes from a superseded stream. Fixes agbossjs/agboss#1051.
