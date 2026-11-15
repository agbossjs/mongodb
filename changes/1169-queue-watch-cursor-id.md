---
section: Fixed
issue: 1169
---

**The child queue's watch records a cursor id of any shape the driver delivers** (agbossjs/agboss#1169) — the watch read the cursor id of its change stream from the command events with `Long` methods, but the driver delivers an id of 53 bits or less as a `number` (`promoteLongs`, the default: about one stream in 500), and every id as a `bigint` with `useBigInt64=true` in `mongodbUrl`. The listener then threw inside the driver's `emit`, on the command's own path: the stream reopened in a loop, woke the queue for nothing and left a cursor on the server each time (until `cursorTimeoutMillis`, 10 min). A `Long`, a `number` and a `bigint` are now one `bigint`, and the kill by id sends it as an int64. The listener never throws, whatever the reply holds: a reply it cannot read is warned about once (the error's name, nothing of the reply). Fixes agbossjs/agboss#1169.
