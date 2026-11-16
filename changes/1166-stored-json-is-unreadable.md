---
section: Fixed
issue: 1166
---

**More stored texts that are not JSON fail with `StoredNamesUnreadableError`** (agbossjs/agboss#1166,
after #1121): an a2a task's status, a message's or a direct message's reply, an audit event, a fenced
effect's result, an execution tree value, a mesh request's response and a pause the channel migration
reads were parsed with a plain `JSON.parse`, so a corrupt document threw a `SyntaxError` with no
`code` whose message quotes the stored text (agbossjs/agboss#906 D4-b). They are the coded error now
(`code: "stored.unreadable"`, the record and its ids), its `cause` a `SyntaxError` that keeps no text.
