---
section: Changed
issue: 962
---

**`MongoCheckpointSaver.latestByStep`: a marked thread's latest checkpoint is one indexed find**
(agbossjs/agboss#962): the core's optional `latestByStep` — the checkpoint of a thread's namespace
with the greatest `metadata.step`, ties by `checkpointId` by byte, a missing or non-number step
counting as -2 — is one sorted `findOne` on the new `latest_by_step` index
(`{ threadId, namespace, step: -1, checkpointId: -1 }`). `step` is written in the checkpoint's own
document by `put` (one replace). Schema version 2 (`0002_checkpoint_latest_by_step`) makes the
index: run `agboss-mongodb migrate` before deploying. A checkpoint written before has no `step`: the
first `latestByStep` of its thread and namespace gives each one (one indexed look finds none
missing afterwards), so no data migration runs at deploy. On 10 000 checkpoints a read went from the
whole-namespace list and sort (3.7 s) to one document examined (1.4 ms). The core's `StoreCapability.LatestByStep`
conformance case joins `store-conformance` at the next core repin.
