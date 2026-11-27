---
section: Added
issue: 1432
---

**`MongoConnection` destroys its sockets when the stop abandons it** (agbossjs/agboss#1432, #954): it
implements the core's `OnAbandon`, called synchronously once when the stop's end passed with `onDestroy`
still running; the client's sockets are dropped at once, never waiting on a server that went quiet.
