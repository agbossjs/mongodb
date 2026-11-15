---
section: Added
issue: 946
---

**A pause can be reassigned** (agbossjs/agboss#946, #1064) — `MongoPausedExecutionRepository`
implements `reassignByTenantIdAndPauseId` and `findPendingUnsentReassignedBefore`. A reassignment is
one transaction: the old pause closed `Cancelled` / `Reassigned` (`reassignedTo`) by the compare-and-set
of an answer's — pending, its deadline after `at` — and its replacement inserted `Pending` and unsent,
a copy for the new assignee with `reassignedFrom`, `askedAt = at` and the step key
`<original>~r<n>` (the lowest number no pause of the tree uses; the suffix is cut only from a
replacement's key): of two racing reassignments, or a reassignment and an answer, one applies. The
re-send scan reads the new partial index `reassigned_unsent` — `(askedAt, tenantId, pauseId)` over
pending, unsent replacements — in its order, with the keyset `after`. The retention keeps a
reassigned pause while its replacement is stored, and removes a chain oldest first, one link per
sweep. The index is made by `agboss-mongodb migrate` (schema version 4); a pause's `reassignedTo`
and a replacement's `reassignedFrom` and `askedAt` are fields of its document.
