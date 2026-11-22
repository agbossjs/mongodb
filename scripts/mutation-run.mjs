#!/usr/bin/env node
// `stryker <args>` with the replica set's transaction lifetime at 10 s for the run's length, put back after it
// (agbossjs/mongodb#103; scripts/transaction-lifetime.mjs): `node scripts/mutation-run.mjs run [stryker options]`.
// `npm run test:mutation` and the rerun of scripts/stryker-timeouts.mjs (`--stryker scripts/mutation-run.mjs`) go through it.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { withTransactionLifetime } from "./transaction-lifetime.mjs";

const LIFETIME_SECONDS = 10;
const url = process.env.AGBOSS_MONGODB_TEST_URL ?? "";
if (url === "") {
  console.error("mutation-run: AGBOSS_MONGODB_TEST_URL is not set (the tests need a replica set)");
  process.exit(1);
}
const bin = join(
  dirname(createRequire(import.meta.url).resolve("@stryker-mutator/core/package.json")),
  "bin",
  "stryker.js",
);

/** Stryker's exit code; a signal sent to this process is passed on to it. */
const strykerRun = () =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], { stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });

process.exitCode = await withTransactionLifetime(url, LIFETIME_SECONDS, strykerRun);
