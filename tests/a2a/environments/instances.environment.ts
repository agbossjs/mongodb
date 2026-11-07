import { secret } from "@agboss/core";
import type { A2AEnvironment } from "./app.environment.js";

/** Each instance on the test's database (the test sets the variable before it starts one). */
export const environment: A2AEnvironment = { mongodbUrl: secret("AGBOSS_A2A_TEST_MONGODB_URL") };
