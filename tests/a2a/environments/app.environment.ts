import type { Secret } from "@agboss/core";

/** The two-instance A2A application's environment (agbossjs/agboss#824): its replica set. */
export class A2AEnvironment {
  mongodbUrl!: Secret;
}
