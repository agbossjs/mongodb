import type { EmptyEnvironment } from "@agboss/core";

/**
 * The stop tests' application settings: none — its database (`AGBOSS_STOP_DATABASE_URL`, named by
 * the test) is a reference its storage reads from the process when it starts.
 */
export const environment: EmptyEnvironment = {};
