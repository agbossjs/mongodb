---
section: Changed
issue: 105
---

**The reasons for the files no mutation shard covers say what the files are** (agbossjs/mongodb#105, agbossjs/agboss#105): `src/stores/bundles.ts` is two lists of store classes for `@Application({ providers })`, not "a read-model of records"; `record-scores.ts` is named as the config snapshot's upsert by its own hash, which only feeds a diagnostic (the drift warning and the listed snapshots), so no run depends on which writer lands first; the audit-event and history documents are read-back parsers, not inserts; `record-documents.ts` also holds one read of a `seq`. No behaviour changed.
