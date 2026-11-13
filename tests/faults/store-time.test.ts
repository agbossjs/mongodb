import { faultSuite } from "@agboss/core/testing/faults";
import { mongoFaultTarget } from "./mongodb-target.js";

/**
 * agbossjs/agboss#971 AC2 — the store-time declaration, checked on every run of CI's `faults` job:
 * one scenario (1, the cheapest) with the shipped MongoDB stores and the pods running 5 times faster,
 * where the rest of the suite runs at 1 (the pods' clock and the real one are the same: no
 * declaration can be told wrong there). At scale 5 the suite's probe
 * measures the stores' clock against the pods': a `storeTime` the stores contradict — `Host` on a
 * set that decides by the server's `$$NOW`, or the reverse — fails `[fault-suite.store-time-mismatch]` before the
 * scenario starts.
 */
faultSuite({
  ...mongoFaultTarget(),
  timeScale: 5,
  scenarios: ["s01-sigterm-drains"],
  sabotages: false,
});
