#!/usr/bin/env node
/**
 * The `check:types` step (agbossjs/agboss#824, as @agboss/postgres's): `agboss check` (the pinned
 * `@agboss/cli`, `npm run install:packed`) on the two-instance A2A test's application, which writes
 * `.agboss/types.d.ts` — the flow types its workflow compiles against (`tsconfig.a2a.json`). Never
 * committed; run before lint and typecheck. The check assembles the application only: the URL its
 * environment names is a placeholder, nothing connects.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = createRequire(join(ROOT, "package.json")).resolve("@agboss/cli/bin/agboss.js");
execFileSync(
  process.execPath,
  [cli, "check", "--application", "tests/a2a/a2a.application.ts", "--env", "instances"],
  {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      AGBOSS_A2A_TEST_MONGODB_URL: "mongodb://placeholder:27017/?replicaSet=rs0",
    },
  },
);
console.log("check:types: wrote .agboss/types.d.ts");
