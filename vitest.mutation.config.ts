import { defineConfig } from "vitest/config";
import { chosenShard } from "./scripts/mutation-shards.mjs";

/**
 * The tests Stryker runs on one shard (`MUTATION_SHARD`, `scripts/mutation-shards.mjs`): that shard's own,
 * against the servers of `npm run coverage`, pinned by the same global setup. One process at a
 * time per mutant; no nested vitest, no containers of a test's own (the close tests pause theirs).
 */
const shard = chosenShard();

export default defineConfig({
  test: {
    include: [...shard.tests],
    exclude: [...(shard.exclude ?? []), "node_modules/**"],
    expect: { requireAssertions: true },
    globalSetup: ["./tests/support/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // a mutant that allocates without end fails at 1 GB in seconds, not at the machine's memory
    // (agbossjs/mongodb#103: it would be a RuntimeError, which Stryker leaves out of the score)
    poolOptions: { forks: { execArgv: ["--max-old-space-size=1024"] } },
  },
});
