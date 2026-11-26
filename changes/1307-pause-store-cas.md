---
section: Breaking
issue: 1307
---

**The pause store on the core's pause train** (agbossjs/agboss#1307, #1324): `extendByTenantIdAndPauseId`
is `changeTimeoutByTenantIdAndPauseId` — a deadline may move either way, be set over none or be
taken away (`expiresAt: null` in the document), over the deadline the caller read and the pause as it
was read (`seen`); the notice kind is `timeout-changed` and it keeps the change's own `actor` and
`changeReason` in its mailbox. `decide…` takes a required `seen` and applies only while the
deadline is ahead; `resolve…` an optional one; `reassign…` compares `seen` whole (trail length,
assignees, deadline, `isSent`). The counts and the cap are the record's own (`escalationLimits`,
`maxExpiresAt`), read in the transaction of the write and narrowed there by a move's destination
(`narrowedLimits`); `markSent…` tells a pause changed in place during its first send what it owes
(`reassigned`). The listing filters `channel`, `assignee`, `externalRef` and the cross-tenant
`findPageOfAllTenants` come with the indexes `by_status`, `by_channel`, `by_assignee` and
`by_external_ref`.

Migration: run `agboss-mongodb migrate` (idempotent) for the new indexes. A pause written before has
no `firstAskedAt` or `escalationLimits` and is unreadable (fail closed); a component of kind
`question` or `reply-interpreter` too (renamed `external-task`, `channel-interpreter`, no legacy
reader): drain the open pauses or rewrite them by hand — filling the limits would loosen the ones a
target had.
