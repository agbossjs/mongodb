import { chosenShard } from "./scripts/mutation-shards.mjs";
import { timeoutOf } from "./scripts/stryker-timeouts-ms.mjs";

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
 * (`scripts/stryker-timeouts-ms.mjs`, agbossjs/mongodb#103, agbossjs/agboss#1367). The net time leaves out the
 * hooks, and a dry run is made alone where the mutants run at once on one server: a mutant no test kills, which
 * runs its whole cover, takes three to four times the dry run. So the factor is 3 and each shard has its own
 * limit. A real hang is ended by vitest's `testTimeout` and `hookTimeout` (a failing test: Killed), or by Stryker's
 * hit limit; what is left a Timeout is judged by `scripts/stryker-timeouts.mjs`.
 */
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
  // see above
  timeoutFactor: 3,
  timeoutMS: timeoutOf(shard.name),
  // the initial run is the shard's own suite on the real servers (its store contracts only): a
  // few minutes; 10 is the bound past which a dry run is a hang, not a slow machine
  dryRunTimeoutMinutes: 10,
  // another shard's sandbox, left by an interrupted run, is no source of this one
  ignorePatterns: [".stryker-tmp-*", "reports"],
  tempDirName: `.stryker-tmp-${shard.name}`,
};
