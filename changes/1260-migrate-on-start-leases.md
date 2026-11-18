---
section: Changed
issue: 1260
---

**`SchemaSetup.MigrateOnStart` follows the rule too** (agbossjs/agboss#1260, #1104, ADR-0034: no
rolling upgrade across a schema change). A start with migrations pending on an already migrated
database no longer migrates over live execution leases: it waits for them to lapse (twice the longest
lease left on the server's clock: at least a minute, at most ten; a stopped single instance's own do)
and fails with `MongoLiveLeasesError` while one is live, so a rolling restart over a running old pod
is refused. No pending migration: no check. `allowLiveLeases: true` in `MongoConnectionSettings`, or
`mongodbAllowLiveLeases: true` in the application's environment, migrates over live leases.
