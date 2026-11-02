import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { startVitest } from "vitest/node";
import type { RunnerTask } from "vitest";

/**
 * agbossjs/agboss#527 — the contract suites bite on MongoDB: three deliberately broken stores run
 * through `storeConformance` (`fixtures/sabotage.conformance-fixture.ts`, in a vitest of its own, so
 * its failures are read, not this run's), and each fails on the rule it breaks. The fourth
 * sabotage — writes acknowledged at `w=1` — is a failover, not a race: `tests/integration/failover.test.ts`.
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface Found {
  readonly suite: string;
  readonly name: string;
  readonly state: string | undefined;
  readonly error: string;
}

const casesOf = (task: RunnerTask, suites: readonly string[]): Found[] =>
  task.type === "suite"
    ? task.tasks.flatMap((child) => casesOf(child, [...suites, task.name]))
    : [
        {
          suite: suites[0] ?? "",
          name: [...suites.slice(1), task.name].join(" > "),
          state: task.result?.state,
          error: task.result?.errors?.[0]?.message ?? "",
        },
      ];

let found: Found[] = [];

beforeAll(async () => {
  const exitCode = process.exitCode;
  const vitest = await startVitest("test", [], {
    root: ROOT,
    config: false,
    watch: false,
    include: ["tests/contracts/fixtures/sabotage.conformance-fixture.ts"],
    globalSetup: [],
    reporters: [{}],
    coverage: { enabled: false },
    testTimeout: 120_000,
    hookTimeout: 60_000,
    maxWorkers: 1,
    minWorkers: 1,
  });
  try {
    found = vitest.state
      .getFiles()
      .flatMap((file) => file.tasks.flatMap((task) => casesOf(task, [])));
  } finally {
    await vitest.close();
    process.exitCode = exitCode;
  }
}, 1_800_000);

/** The failed cases of `suite`. */
const failedIn = (suite: string): Found[] =>
  found.filter((one) => one.suite === suite && one.state === "fail");

/** The invariants named by the failing explorer cases of `name`'s set. */
const invariantsOf = (name: string): ReadonlySet<string> =>
  new Set(
    failedIn(`interleavings (${name})`).flatMap(
      (one) => /\): \[([a-z-]+)\]/u.exec(one.error)?.[1] ?? [],
    ),
  );

describe("agbossjs/agboss#527: the contract suites bite on MongoDB", () => {
  it("prints what each broken set failed", () => {
    for (const suite of new Set(found.map((one) => one.suite))) {
      const failed = failedIn(suite);
      const all = found.filter((one) => one.suite === suite).length;
      const names = failed.map((one) => `  × ${one.name}\n`).join("");
      process.stdout.write(
        `[sabotage] ${suite}: ${String(failed.length)} of ${String(all)} failed\n${names}`,
      );
    }
    expect(found.length).toBeGreaterThan(0);
  });

  it("leases on the caller's clock: every 'store's time is the authority' case, and one-live-holder in the explorer", () => {
    const authority = found.filter(
      (one) =>
        one.suite === "lease contract (leases on the caller's clock)" &&
        one.name.startsWith("the store's time is the authority"),
    );

    expect(authority.length).toBeGreaterThan(0);
    expect(authority.every((one) => one.state === "fail")).toBe(true);
    expect(invariantsOf("leases on the caller's clock")).toContain("one-live-holder");
  });

  it("a check-then-write acquire: two owners of one free lease — the core's races of two takes (#695) and this repository's", () => {
    const races = found.filter((one) => one.suite === "lease races (a check-then-write acquire)");
    const core = failedIn("lease contract (a check-then-write acquire)");

    expect(races).toHaveLength(3);
    expect(races.every((one) => one.state === "fail")).toBe(true);
    expect(core).toHaveLength(3);
    expect(
      core.every((one) => one.name.startsWith("two takes of a free lease at once > #695")),
    ).toBe(true);
  });

  it("a fence check that only reads: a take inside the zombie's open transaction, and the zombie's write landing after it", () => {
    const [race] = failedIn("fence races (a fence check that only reads)");
    const core = failedIn("fenced effect contract (a fence check that only reads)").map(
      (one) => one.name,
    );

    expect(race?.error).toContain("takenDuringWork");
    expect(core).toContain(
      "a key built by hand, a zombie > #695: the lease released and taken while its holder's write runs: the hand-over waits for the write, or the write is refused — never the take during the work and the write landing after it",
    );
  });
});
