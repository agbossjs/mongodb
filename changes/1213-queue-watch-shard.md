---
section: Changed
issue: 1213
---

**The child queue's watch is mutation-tested too** (agbossjs/agboss#1213, agbossjs/mongodb#91): `queue-changes.ts`, `queue-watch.ts`, `queue-watch-cursors.ts` and `watch-client.ts` — the change stream, the cursors it knows of and the close that kills them — are the tenth shard of `scripts/mutation-shards.mjs` (`queue-watch`), at 100 % killed or justified like the other nine; CI runs it as its own `mutation` job and the nightly run covers it. The stores behave as before.
