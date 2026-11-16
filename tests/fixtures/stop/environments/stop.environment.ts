import { secret } from "@agboss/core";
import type { StopEnvironment } from "./stop.contract.js";

/** The stop tests' replica set (the test names it) and its database. */
export const environment: StopEnvironment = {
  mongodbUrl: secret("AGBOSS_STOP_DATABASE_URL"),
  mongodbDatabase: "agboss_stop",
  openRouterApiKey: secret("AGBOSS_STOP_OPENROUTER_KEY"),
};
