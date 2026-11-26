---
section: Breaking
issue: 1324
---

**The connection is the storage's, not the environment's** (agbossjs/agboss#1324): `MongoConnection`
reads its settings from the application's `@DatabaseStorage({ driver: MongoDriver({ url }) })` (or a
settings object a script or a test gives); the `mongodb…` environment fields, `environmentFields` and
the assembly check on them are gone, `MongoDriver`'s `schemaSetup`, `transactionReadConcern`, `database`
and `timeouts.watchLiveness` are where they went, and `allowLiveLeases` is the connection settings'
and the migrate command's `--allow-live-leases`. An application with no MongoDB storage and no
settings fails with `MongoSettingsError`. A store class listed in `providers` beside a `storage` is
`[storage.providers-conflict]`. The fault set names its database in `storage` (`FaultStoreSet.storage`).
