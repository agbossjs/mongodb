import { runConformanceSabotage, type SabotageCase } from "@agboss/core/testing/contracts";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * agbossjs/agboss#527 — the contract suites bite on MongoDB: three deliberately broken stores run
 * through `storeConformance` (`fixtures/sabotage.conformance-fixture.ts`, in a vitest of its own, so
 * its failures are read, not this run's), and each fails on the rule it breaks. The fourth
 * sabotage — writes acknowledged at `w=1` — is a failover, not a race: `tests/integration/failover.test.ts`.
 */
let found: readonly SabotageCase[] = [];

beforeAll(async () => {
  // agbossjs/agboss#831: the core's runner — a fixture that does not load, a hook that fails or a
  // path that names nothing rejects here, never an empty run
  const run = await runConformanceSabotage({
    root: new URL("../../", import.meta.url),
    fixtures: ["tests/contracts/fixtures/sabotage.conformance-fixture.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  });
  found = run.cases;
}, 1_800_000);

/** The outermost suite of `one`. */
const suiteOf = (one: SabotageCase): string => one.suites[0] ?? "";

/** `one`'s name under its outermost suite. */
const nameOf = (one: SabotageCase): string => [...one.suites.slice(1), one.name].join(" > ");

/** The first error of `one`. */
const errorOf = (one: SabotageCase): string => one.errors[0] ?? "";

/** The failed cases of `suite`. */
const failedIn = (suite: string): SabotageCase[] =>
  found.filter((one) => suiteOf(one) === suite && one.state === "fail");

/** The invariants named by the failing explorer cases of `name`'s set. */
const invariantsOf = (name: string): ReadonlySet<string> =>
  new Set(
    failedIn(`interleavings (${name})`).flatMap(
      (one) => /\): \[([a-z-]+)\]/u.exec(errorOf(one))?.[1] ?? [],
    ),
  );

describe("agbossjs/agboss#527: the contract suites bite on MongoDB", () => {
  it("prints what each broken set failed", () => {
    for (const suite of new Set(found.map((one) => suiteOf(one)))) {
      const failed = failedIn(suite);
      const all = found.filter((one) => suiteOf(one) === suite).length;
      const names = failed.map((one) => `  × ${nameOf(one)}\n`).join("");
      process.stdout.write(
        `[sabotage] ${suite}: ${String(failed.length)} of ${String(all)} failed\n${names}`,
      );
    }
    expect(found.length).toBeGreaterThan(0);
  });

  it("leases on the caller's clock: every 'store's time is the authority' case, and one-live-holder in the explorer", () => {
    const authority = found.filter(
      (one) =>
        suiteOf(one) === "lease contract (leases on the caller's clock)" &&
        nameOf(one).startsWith("the store's time is the authority"),
    );

    expect(authority.length).toBeGreaterThan(0);
    expect(authority.every((one) => one.state === "fail")).toBe(true);
    expect(invariantsOf("leases on the caller's clock")).toContain("one-live-holder");
  });

  it("a check-then-write acquire: two owners of one free lease — the core's races of two takes (#695) and this repository's", () => {
    const races = found.filter(
      (one) => suiteOf(one) === "lease races (a check-then-write acquire)",
    );
    const core = failedIn("lease contract (a check-then-write acquire)");

    expect(races).toHaveLength(3);
    expect(races.every((one) => one.state === "fail")).toBe(true);
    expect(core).toHaveLength(3);
    expect(
      core.every((one) => nameOf(one).startsWith("two takes of a free lease at once > #695")),
    ).toBe(true);
  });

  it("a fence check that only reads: a take inside the zombie's open transaction, and the zombie's write landing after it", () => {
    const [race] = failedIn("fence races (a fence check that only reads)");
    const core = failedIn("fenced effect contract (a fence check that only reads)").map((one) =>
      nameOf(one),
    );

    expect(race === undefined ? undefined : errorOf(race)).toContain("takenDuringWork");
    expect(core).toContain(
      "a key built by hand, a zombie > #695: the lease released and taken while its holder's write runs: the hand-over waits for the write, or the write is refused — never the take during the work and the write landing after it",
    );
  });
});
