---
section: Changed
issue: 103
---

**Every mutation shard is run to its end, and none of its Timeouts counts as killed unless it is a proven hang** (agbossjs/mongodb#103, written agbossjs/agboss#103 as the changelog check reads it; agbossjs/agboss#1367): a Timeout counted as killed and hid survivors in the `leases` and `migrations` shards; the conformance suites of a shard are chosen by `MUTATION_SHARD` (a `testNamePattern` overrode Stryker's per-test filter on every mutant, so a mutant covered by two tests ran them all), `timeoutFactor` is 3, and `scripts/stryker-timeouts.mjs` fails a shard on a Timeout that is not in the reviewed list of proven hangs, on an entry of it that no Timeout matches, and on a mutant that ended in an error. Two more shards (`a2a-direct`, `checkpoints`), and the tests that kill what the first complete runs found; no store behaves differently. Two stop checks that were read once outside their loop (the liveness watch's and the queue watch's reopen) are read in it.
