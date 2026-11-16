---
section: Fixed
issue: 1182
---

**The stale-stream watch test no longer counts warnings against wall time** (agbossjs/agboss#1182):
`queue-watch-stale-stream.test.ts` asserted exactly one warning in its settle window, but a slow
runner can lose the new stream to a second liveness expiry, or answer the cursor kill late, and
both warn legitimately. It now counts the wakes against the losses of the stream (one catch-up
wake per reopen, none from a dropped stream). The watch itself is unchanged.
