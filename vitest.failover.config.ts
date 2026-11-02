import { defineConfig } from "vitest/config";

/**
 * agbossjs/agboss#527 AC3 — the failover (`npm run test:failover`, part of `npm run check`): it
 * stops replication, steps the replica set's primary down and heals the set after, so it runs
 * alone, after every other file.
 */
export default defineConfig({
  test: {
    include: ["tests/integration/failover.test.ts"],
    expect: { requireAssertions: true },
    globalSetup: ["./tests/support/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 300_000,
  },
});
