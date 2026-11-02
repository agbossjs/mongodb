import { faultSuite } from "@agboss/core/testing/faults";
import { mongoFaultTarget } from "./mongodb-target.js";

/**
 * agbossjs/agboss#484 AC2, agbossjs/agboss#527 AC2 — every scenario of the core's fault suite on
 * MongoDB: real `node` pods on one replica set, killed, stopped, frozen and cut off it, every
 * invariant (the linearizability of the store's history included) checked after each
 * (`npm run test:faults`, CI's `faults` jobs).
 */
faultSuite(mongoFaultTarget());
