---
section: Breaking
issue: 1321
---

**One 0.1.1 baseline schema, version 1** (agbossjs/agboss#1321c): `MIGRATIONS` restarts at `{ version: 1, name: "baseline_0_1_1" }`, every collection and index 0.1.0's versions 1-4 made. A 0.1.0 database is not migrated, and the migration no longer fills the pauses' `channel` from their records. Each store train that changes the schema adds the next version, when the train is cut.
