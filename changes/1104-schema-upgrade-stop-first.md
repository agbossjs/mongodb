---
section: Changed
issue: 1104
---

**`migrate` refuses while an execution lease is live** (agbossjs/agboss#1104, ADR-0034) — a schema
upgrade is stop every old instance, migrate, then deploy. With migrations pending on an already
migrated database, `agboss-mongodb migrate` / `migrateMongodb` find the execution leases that are not
released, finished or superseded and expire after the server's clock: if there is one nothing is
applied and the run fails with `MongoLiveLeasesError` (`mongodb.live-leases`, `count`, up to 5
`holders`); `--allow-live-leases` / `allowLiveLeases: true` migrates anyway. A database at this
version stays a no-op, exit 0. An idle old instance holds no lease and is not seen; as the
backstop, a channel-filtered page of pauses now gives a pause with no `channel` (one an old instance
wrote after the migration) its channel from its record. A start with `SchemaSetup.MigrateOnStart`
is held to the same rule (agbossjs/agboss#1260). The README says stop, migrate, deploy and where a pre-upgrade hook is still right.
