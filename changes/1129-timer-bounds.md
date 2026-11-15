---
section: Fixed
issue: 1129
---

**`watchLivenessSeconds` has an upper limit** (agbossjs/agboss#1129) — a value above 3600 s (`MAX_WATCH_LIVENESS_SECONDS`) is refused with a `MongoSettingsError` naming the field, on the settings object and in the environment (`mongodbWatchLivenessSeconds`); before, 2147484 s overflowed Node's timer (2^31-1 ms), the watch failed at once and the instance silently fell back to the sweep. The connection also copies the settings object it is given: changing it after construction no longer bypasses the check.
