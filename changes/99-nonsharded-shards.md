---
section: Changed
issue: 99
---

**The connection, its settings, the command, and the order and numbers of the writes are mutation-tested too** (agbossjs/mongodb#99, written agbossjs/agboss#99 as the changelog check reads it; part of agbossjs/agboss#1213): `local-order.ts` and `sequence.ts` (`ordering`), `settings.ts` (`settings`), `cli.ts` (`cli`) and `mongodb-connection.ts` (`connection`) are four more shards of `scripts/mutation-shards.mjs`, at 100 % killed or justified like the other ten; CI runs each as its own `mutation` job and the nightly run covers them, and none of the five is left in the list of files no shard mutates. The stores behave as before; the command line's arguments are read by a simpler loop with the same results, and the connection no longer tests whether the error of a commit it read is the one of unknown outcome (it always is).
