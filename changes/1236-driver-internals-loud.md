---
section: Fixed
issue: 1236
---

**A driver without the internals of the bounded stop fails the start, not the stop** (agbossjs/agboss#1236) —
the stop that leaves no socket open (#954) reaches the `mongodb` driver's non-public `client.topology` by name.
`MongoConnection.onInit` now checks it once the client is connected (`topology.close`, `topology.s.servers`,
each pool's `checkedOut`) and fails with `MongoDriverInternalsError` (`mongodb.driver-internals-missing`),
which names the driver's version and the missing internal, when a driver release renamed or reshaped one:
the stop is never left silently off. The `mongodb` dependency is held to the exact version the stop was
tested with (`7.9.0`, no range), so an install, `install:packed` included, takes no other, and a test loads
the installed driver and asserts the internals and the pin: a driver bump fails CI.
