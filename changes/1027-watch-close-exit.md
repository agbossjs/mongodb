---
section: Fixed
issue: 1027
---

**The process exits promptly after the child queue's watch is closed on a silent network** (agbossjs/agboss#1027) — the watch's clients dropped as silent, and every reconnect the network swallowed, kept sockets and monitor timers for the driver's 30 s timeouts, retried, so a process stayed up 27–200 s after `close()` and `MongoConnection.onDestroy()`. The watch's client now gives up on a connection not up within half of `mongodbWatchLivenessSeconds`, waits at most the bound for a reply, checks the server every quarter of it and does not retry: nothing the watch opened keeps the process alive past twice the bound.
