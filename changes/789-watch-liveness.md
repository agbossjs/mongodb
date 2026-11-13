---
section: Fixed
issue: 789
---

**The child queue's change stream notices a connection that dies silently** (agbossjs/agboss#789)
— a half-open TCP connection (a NAT or a load balancer that lost its state: no FIN, no RST) no
longer stops the wake-ups of #777 with no sign; the driver alone saw it after about 40 s, past the
sweep. The watch runs on a client of its own and pings it; when the answer does not come within
`mongodbWatchLivenessSeconds` (default 10 s, at least 2:
`MongoConnectionSettings.watchLivenessSeconds`) it logs `child-queue.watch-connection-lost` at
`warn`, opens the stream on a new client and wakes the claimers once. Every timer is on the
`Clock`. `MongoChildExecutionQueueRepository` takes the `Logger` as its fourth dependency.
