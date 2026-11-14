---
section: Fixed
issue: 906
---

**A stored JSON text that is not JSON is refused by the ids of its row, never by its text** (agbossjs/agboss#906 D4, #934) — a paused run, a pause (its record and its closing), an answer-log entry and a kept history record are read back through the core's schemas, which check every field (0.1.0's names read too) and refuse a bad value with `StoredNamesUnreadableError`, naming the ids and the field. A text that is not JSON at all (cut off, empty, damaged) used to surface the parser's `SyntaxError`, whose message quotes the text (`startInput`, the caller's data): it is now an error naming what was stored and its row's ids (`threadId`, `runId`, `pauseId`, `executionId`), with neither the text nor the parser's message, no tenant and no cause. Fixes agbossjs/agboss#906.
