---
section: Changed
issue: 939
---

**`findClosedByResolvedAtBefore(cutoff, limit, after?)` returns a page with a cursor** (agbossjs/agboss#939, core #977) — the pauses the retention's `deleteByResolvedAtBefore` would remove are listed `limit` (1 to 1000) per page in the store's insertion order, `after` the `next` of the page before (the insertion sequence, as `findOpenAfter`'s), so a backlog closed in one millisecond or not is read whole, page by page, before anything is removed; the page's `next` is set only when more follow. A cursor that is not one is a `TypeError`.
