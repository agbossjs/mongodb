import { defineConfig } from "vitest/config";

/**
 * agbossjs/agboss#484 — the fault suite (`npm run test:faults`): real pods on the test replica set,
 * one file at a time, its scenarios one after another. Not in `npm run check`: it runs in CI's
 * `faults` jobs.
 */
export default defineConfig({
  test: {
    include: ["tests/faults/**/*.test.ts"],
    expect: { requireAssertions: true },
    globalSetup: ["./tests/support/global-setup.ts"],
    fileParallelism: false,
    hookTimeout: 60_000,
  },
});
