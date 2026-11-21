/**
 * agbossjs/mongodb#103 (agbossjs/agboss#1367): Stryker's limit for one mutant is `timeoutFactor` x the net time of the
 * tests that cover it + `timeoutMS`; a static mutant, or one every test covers, has the net time of the whole shard,
 * and the net time leaves out hooks and setup (the dry run's "overhead"). A mutant no test kills then outlasted a
 * short limit, read as a Timeout, and a Timeout counts as killed: a survivor hid in the score (the `leases` and
 * `migrations` shards). The dry run is one worker alone, the mutants run two or three at once, so a mutant's run takes
 * up to 3 x the dry run's: `timeoutFactor` is 3 (`stryker.config.mjs`) and `timeoutMS` here is 120 s at least (an async
 * test that hangs is ended by vitest after `testTimeout`, its hooks after `hookTimeout`: a chain of up to about
 * 50 s), and the `migrations` shard, whose hooks (a database made and migrated per case) dominate, 240 s, measured.
 * `connection` and `store-bound`, 900 s: most of their mutants are static (module-level code: a constructor, the start's
 * checks), which Stryker runs against every covering test with the environment reloaded for each, and on CI's runners that
 * took more than 300 s (3 of 50 and 4 of 260 mutants, a different few each run: Killed locally, a Timeout of the clock on CI).
 * A Timeout is then a hang: a loop whose guard the mutant took away, and `scripts/stryker-timeouts.mjs` fails a job on
 * one that is not in `scripts/stryker-proven-hangs.json`. A new shard needs its entry.
 */
export const TIMEOUTS_MS = {
  leases: 120_000,
  fence: 120_000,
  "effects-and-calls": 120_000,
  pauses: 120_000,
  money: 120_000,
  queue: 120_000,
  "queue-watch": 120_000,
  "a2a-direct": 120_000,
  checkpoints: 120_000,
  ordering: 120_000,
  settings: 120_000,
  cli: 120_000,
  connection: 900_000,
  migrations: 240_000,
  outcome: 120_000,
  "store-bound": 900_000,
};

/**
 * The `timeoutMS` of `shard`; a shard without an entry fails to load, never runs on a default.
 * @param {string} shard
 * @returns {number}
 */
export function timeoutOf(shard) {
  const ms = TIMEOUTS_MS[shard];
  if (ms === undefined)
    throw new Error(
      `TIMEOUTS_MS (agbossjs/mongodb#103): shard "${shard}" has no entry: set it, 120 s at least`,
    );
  return ms;
}
