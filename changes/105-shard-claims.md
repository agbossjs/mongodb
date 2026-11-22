---
section: Changed
issue: 105
---

**The A2A task store, the mesh request store and the execution record store are mutation-tested at 100 %** (agbossjs/mongodb#105, agbossjs/agboss#1213, agbossjs/agboss#1367): three new shards, `a2a-tasks` (`saveIfAbsent`: of several pods accepting one message exactly one saves it; `compareAndSetStatus` on a non-terminal state: of several writers at one version exactly one lands; the message and reply claims, the page of `list`, the retention sweep), `mesh-requests` (`saveIfAbsent`: of several instances admitting one idempotency key exactly one inserts it) and `execution-records` (`completeIfStatus`: the paused to running mark of an answer that reaches any instance, written with no lease, lands once; a thread id is created once, a minted one never handed out twice). Each once-only claim has a test in which several instances race on connections of their own, released together; a read-then-write in place of the claim fails it. The execution tree store stays unsharded, and its reason now names each writer of `saveIfAbsentInTree`. Part of agbossjs/agboss#105.
