---
section: Added
issue: 938
---

**The pause store's contract v2: deadlines, notices, not-taken answers** (agbossjs/agboss#938,
step 4 of #910; core #958, #969) — `MongoPausedExecutionRepository` implements every method of
the core's contract v2. **Schema version 3** (`pause-deadlines-and-notices`): `agboss_pauses`
gains `expiresAt`, `remindAt` (BSON Dates), `expiryBound` and `channel` and the indexes
`pending_by_expiry`, `pending_by_remind` (partial on `status: "pending"` and a date),
`by_tenant`, `open`; the new collection `agboss_pause_notices` (one mailbox per pause and
receiver, `headWrittenAt` and every notice's `writtenAt` BSON Dates) has `due`, `stale`,
`by_pause`. Run `agboss-mongodb migrate`: a version-2 database keeps its pauses (each gets its
`channel` from its record; idempotent, concurrent runs end in one schema), and an application at
schema 2 refuses to start against it (`MongoSchemaTooNewError`). Every transition is one
compare-and-set in a transaction with its notices — the deadline in the filter (`at` before
`expiresAt` for a resolve, at or after it for an expiry), the notices appended by an update
pipeline (`$ifNull` for a missing `notices`, `seq` the next place), never relying on a
duplicate-key error inside a transaction; `noticeOnce…` reads the pause, then the pause's
mailboxes, then appends. Claims, acknowledgements, retries and set-asides are one conditional
command on one mailbox. The scans' cursor is the insertion sequence (a counter that only grows),
so deleting the newest row and inserting another never reuses a number.
`markPauseAnswerNotTaken` keeps the first entry's place in the order; `closeUntaken` keeps the
first close's facts in `closedFirst`. `deleteByTenantIdAndThreadIdAndRunId` is one statement.
