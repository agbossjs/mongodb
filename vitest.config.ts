import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // a test that asserts nothing proves nothing (the core's #180)
    expect: { requireAssertions: true },
    // the unit tests run anywhere; the integration tests need AGBOSS_MONGODB_TEST_URL — in CI a
    // missing URL fails the run, locally those tests are skipped with a notice (see the setup)
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
