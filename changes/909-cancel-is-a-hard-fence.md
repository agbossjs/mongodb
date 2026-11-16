---
section: Added
issue: 909
---

**Cancel is a hard fence for effects** (agbossjs/agboss#909, #1117): once a tree's cancel request
is durable (`MongoExecutionLeaseRepository.requestCancel`), a fenced effect and an outbound call's
new intent or new attempt of that tree are refused with `ExecutionCancelFencedError` in the
transaction that checks the lease — nothing written, nothing sent; a stored effect still replays and
an undo's key is not refused. The mark is the field `cancelRequestedAt` of the tree's own lease
document, **permanent**: every write of the document keeps it and no retention removes it. A cancel
before the tree's first `acquire` writes a seed document (token 0, released, no holder): that
`acquire` is token 1 with no takeover. A fenced write writes the root's document first (a child's
key seeds its root's), so a cancel waits for the open transaction or commits before it and is read.
**Schema version 4** (`execution-cancel-mark`): no collection, no index — run
`npx agboss-mongodb migrate` before rolling out; a build of an older version refuses the database.

`isCancelRequested(tree)` (agbossjs/agboss#1152) reads the mark: `cancelRequestedAt` of the tree's lease
document, tenant-scoped by the document's key, a seed document counting — one majority read, nothing
changed; the sweep ends a resting tree whose cancel died after its durable request by it.
