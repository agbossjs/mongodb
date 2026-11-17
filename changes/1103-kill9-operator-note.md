---
section: Changed
issue: 1103
---

**The README says what a `kill -9` mid-transaction costs** (agbossjs/agboss#1103, item 4): the killed
pod's transaction stays open on the server and keeps its documents locked, so another instance's
change of that pause waits for the server to abort it, about 60 s (`transactionLifetimeLimitSeconds`);
nothing is lost, nothing is left to clean up.
