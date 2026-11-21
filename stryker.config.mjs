import { chosenShard } from "./scripts/mutation-shards.mjs";

/**
 * Mutation testing of the money-path modules (agbossjs/agboss#1213, the core's #533 item 3, #626):
 * every mutant is killed by a test or justified in writing where it stands (a `Stryker disable`
 * comment naming only the mutators whose every mutant on its line is equivalent, with the reason,
 * the core's #619). The score is gated (`thresholds.break` 100). One shard per run, its own
 * incremental file (`reports/stryker-incremental-<shard>.json`, cached by CI per shard).
 * Locally: `MUTATION_SHARD=<shard> npm run test:mutation` (3 workers at most), with the servers
 * of `npm run coverage` set.
 */
const shard = chosenShard();

/**
 * The bound of a mutant's run is `timeoutFactor` x the net time of the tests that cover it + `timeoutMS`
 * (agbossjs/mongodb#103). The net time leaves out the hooks (a database made, a connection opened), and
 * a dry run is made alone where the mutants run three at a time on one server: a mutant no test kills,
 * which runs its whole cover, takes three to four times the dry run. So the factor is 3, and a shard whose
 * hooks dominate (`migrations`) carries its own `timeoutMS` in `mutation-shards.mjs`, measured. A real hang
 * is ended by vitest's `testTimeout` and `hookTimeout` (a failing test: Killed), or by Stryker's hit limit;
 * what is left a Timeout is judged by `scripts/stryker-timeouts.mjs`.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts" },
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: shard.mutate,
  coverageAnalysis: "perTest",
  concurrency: shard.concurrency ?? 3,
  incremental: true,
  incrementalFile: `reports/stryker-incremental-${shard.name}.json`,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: `reports/mutation/${shard.name}.json` },
  thresholds: { high: 100, low: 95, break: 100 },
  // see DEFAULT_TIMEOUT_MS above
  timeoutFactor: 3,
  timeoutMS: shard.timeoutMS ?? DEFAULT_TIMEOUT_MS,
  // the initial run is the shard's own suite on the real servers (its store contracts only): a
  // few minutes; 10 is the bound past which a dry run is a hang, not a slow machine
  dryRunTimeoutMinutes: 10,
  // another shard's sandbox, left by an interrupted run, is no source of this one
  ignorePatterns: [".stryker-tmp-*", "reports"],
  tempDirName: `.stryker-tmp-${shard.name}`,
};
