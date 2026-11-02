import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // the fault suite (agbossjs/agboss#484) and the failover (it steps the primary down: no other
    // file may run beside it) run on their own: vitest.faults.config.ts, vitest.failover.config.ts
    exclude: ["tests/faults/**", "tests/integration/failover.test.ts", "node_modules/**"],
    // a test that asserts nothing proves nothing (the core's #180)
    expect: { requireAssertions: true },
    // every test file needs AGBOSS_MONGODB_TEST_URL and AGBOSS_MONGODB_STANDALONE_TEST_URL: it
    // fails without them, never skips (see the setup)
    globalSetup: ["./tests/support/global-setup.ts"],
    // at most two workers: the suite runs next to other work on a developer's machine
    maxWorkers: 2,
    minWorkers: 1,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html", "json-summary"],
      // the core's thresholds (packages/agboss/vitest.config.ts), its 90 % for the stores' kind
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
