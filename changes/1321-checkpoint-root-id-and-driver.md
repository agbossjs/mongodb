---
section: Added
issue: 1321
---

**`MongoDriver`, and a tree's checkpoints deleted by their stored root** (agbossjs/agboss#1321d, #1321f): `@DatabaseStorage({ driver: MongoDriver({ url: secret("MONGODB_URL"), database, timeouts }) })` brings the connection and every store, with the lease store and the coordination stores named and `agboss migrate db` wired to `migrateMongodb` (`StorageMigrate`, refusing live leases unless `--allow-live-leases`); the environment's `mongodb…` fields stay for an application without a storage component. The `commandTimeout` and `idleInTransactionTimeout` options are PostgreSQL's and are refused with `MongoSettingsError`. `MongoCheckpointSaver.deleteThread(rootExecutionId)` deletes the thread and every thread whose stored `rootId` is it — never by a range or a prefix of thread ids: checkpoints and pending writes carry `rootId` (from `configurable.root_execution_id`; a thread that names none is its own root) and an index `by_root`.
