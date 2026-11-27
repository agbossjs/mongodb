---
section: Breaking
issue: 1307
---

**The pause store holds `Date`s and calls the core's pure transitions** (agbossjs/agboss#1307, P6b): every
time of a pause, its notices and the answer log is a `Date`; the store's own copies of the rules
(`decideChange`, `resolveChange`, `timeoutChange`, `reassignChange`, the notice plans, the cap) are gone
and the core's are called, so the stores cannot diverge. The exported types `PauseChange` and
`PlannedNotice` of this package are the core's `PauseTransition` and `PlannedNotice`. The fields a query
reads are BSON Dates in every document, the JSON a record keeps is canonical ISO text read back in that
spelling only, and an Invalid `Date` is refused (`StoreError.UnreadableRecord`) before anything is
written. The answer log's `askedAt` is a BSON Date (a database made by an earlier unreleased build with
text there is to be recreated). `MongoDriver`'s `database` is `string | EnvRef<string>`.
