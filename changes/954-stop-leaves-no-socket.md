---
section: Fixed
issue: 954
---

**A stop against a quiet MongoDB leaves no socket open** (agbossjs/agboss#954) — `MongoConnection.onDestroy`
and the child queue's watch close the driver's topology of every client they made beside its `close()`,
so the idle pooled connections and the monitors' sockets are destroyed, not left to the server that
never answers. When calls are in flight at the stop (a stop that has used its time on them is given
one turn of the loop for each hook) the sockets go at once; else after the close's grace (1 s), an
orderly close on a healthy server ending sooner and telling it about its sessions. The driver's
`close()` takes no `force` and waits for the server first. A connection attempt whose handshake the
server never answered ends by the client's own `connectTimeoutMS`: the driver keeps no handle to it.
An `execute()` the stop abandons settles with `ApplicationStoppingError` (`app.stopping`).
