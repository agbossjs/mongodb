---
section: Fixed
issue: 1345
---

**A queue watch's `close()` leaves no change-stream cursor on the server when its own `killCursors` cannot go out in time** (agbossjs/agboss#1345) — on a loaded server the stream's close missed its bound, the client's sockets were dropped with the `killCursors` still queued, and the cursor stayed until `cursorTimeoutMillis` (10 min). The close now kills the stream's cursors by id over a short-lived client when its own close did not end in the bound, and first waits, within the liveness bound, for a stream's `aggregate` still in flight to be answered, as its reply is the only place the cursor's id is told. A cursor whose `aggregate` gets no answer within the bound is left to the server's cursor timeout (no socket outlives the stop). Fixes agbossjs/agboss#1345.
