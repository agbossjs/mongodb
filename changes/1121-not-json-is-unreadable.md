---
section: Fixed
issue: 1121
---

**A stored text that is not JSON fails with `StoredNamesUnreadableError`** (agbossjs/agboss#1121) — a paused run or a pause answer (and, on MongoDB, a pause, its closing and a history record) whose stored text was no JSON failed with a plain `Error` that had no `code`, while a record that failed the schema check was `StoredNamesUnreadableError` (`code: "stored.unreadable"`). Both are the coded error now, with the row's ids; its `cause` is a `SyntaxError` that keeps no stored text (the parser's own message quotes it).
