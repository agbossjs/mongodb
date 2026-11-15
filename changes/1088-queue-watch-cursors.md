---
section: Fixed
issue: 1088
---

**The child queue's watch no longer leaves change-stream cursors on the server** (agbossjs/agboss#1088) — a watch's `close()` closed its stream and its client at the same time, and the client's one-connection pool shut before the stream's `killCursors` went out, so every close left an idle cursor until `cursorTimeoutMillis` (10 min). The stream is now closed first (bounded on the clock by the close grace plus the longest a `getMore` is held), then the client. A stream dropped as dead (the black-hole reopen) cannot tell the server anything, its one connection being the dead one: the watch reads the cursor id and namespace (nothing else) from the stream client's `aggregate` and `getMore` replies and kills a superseded stream's cursors by id (`killCursors`) over a short-lived client made for the kill (the stream's own connection carries the liveness ping), and closed after, bounded on the clock. A kill that fails, or gets no answer, is warned about once and not retried; a server that cannot be reached keeps the cursor until `cursorTimeoutMillis` ends it. Fixes agbossjs/agboss#1088.
