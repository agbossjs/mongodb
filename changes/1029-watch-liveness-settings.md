---
section: Fixed
issue: 1029
---

**A settings object's `watchLivenessSeconds` is checked** (agbossjs/agboss#1029) — `new MongoConnection({ url, watchLivenessSeconds: 0 | 1 | -1 | 2.5 | NaN })` is refused with a `MongoSettingsError` naming the field (a whole number of at least 2), as `mongodbWatchLivenessSeconds` is in the environment; before, `0` made the watch fail later with a misleading message and `1` pinged every 0.5 s.
