---
section: Fixed
issue: 1341
---

**A reclaim under an Immediate pause inherits the fence, and a checkpoint's config keeps its tree** (agbossjs/agboss#1341c, #1321d):
`reclaim` raises `fencedThroughToken` to the reclaimed token while the tree is paused `Immediate` from outside, so the
root's write on the reclaimed token is refused like any other (the core's lease and fenced-effect contract cases);
`MongoCheckpointSaver.put` gives back a config that names the tree's root when the thread is not its own root, so
`deleteThread(root)` finds every checkpoint and write of the tree. No migration.
