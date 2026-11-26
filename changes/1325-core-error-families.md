---
section: Breaking
issue: 1325
---

**The store errors are the core's `StoreError` variants** (agbossjs/agboss#1325, #909): a lost answer is `StoreError.OutcomeUnknown` (`store`, `operation`, `source`; a commit or a single write passes `StoreError.CallTimeout`, a variant of its own now, as it is — test both with `isStoreOutcomeUnknown(error)` from `@agboss/core/stores`); an unreadable stored record is `StoreError.UnreadableRecord` (`store.unreadable-record`, was `stored.unreadable`); an entry the ledger may have pruned is `StoreError.LedgerEntryExpired` (`store.ledger-entry-expired`, was `cost-ledger.entry-expired`); a write after its tree's cancel is refused with `cancelFencedOf(key)`, an `ExecutionError.CancelFenced`; minted ids that are all taken are `ExecutionError.ThreadIdsExhausted`. The `Stored…`, `Store…Error`, `CostLedger…Error` and `ExecutionCancelFencedError` classes are gone from the core. No migration.
