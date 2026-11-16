import type { Secret } from "@agboss/core";

/** The environment the stop tests' application reads: the MongoDB connection's fields. */
export class StopEnvironment {
  mongodbUrl!: Secret;
  mongodbDatabase?: string;
  /** The built-in model provider's key: a placeholder, the workflows call no model. */
  openRouterApiKey!: Secret;
}
