/**
 * agbossjs/agboss#691 AC2 — the release workflow publishes `@agboss/mongodb` only on its own tag,
 * at its own version, on the published core the pin and the peer dependency name, and only after
 * CI passed on a push of that exact commit (`scripts/release/release-plan.mjs`,
 * `scripts/release/ci-gate.mjs`); the pin moves between a commit and the registry with
 * `scripts/pin-framework.mjs`.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = new URL("../../", import.meta.url).pathname;

interface Problem {
  readonly problem: string;
  readonly isReleaseMoment: boolean;
}
interface Pin {
  readonly repository?: string;
  readonly source?: string;
  readonly frameworkSha?: string;
  readonly version: string;
}
interface Release {
  readonly releaseProblemsOf: (input: {
    readonly tag: string | undefined;
    readonly pkg: {
      readonly name: string;
      readonly version: string;
      readonly peerDependencies?: Record<string, string>;
    };
    readonly pin: Pin;
    readonly publishedCoreVersions: readonly string[];
  }) => readonly Problem[];
  readonly blockingProblemsOf: (
    problems: readonly Problem[],
    options: { readonly isDryRun: boolean },
  ) => readonly Problem[];
  readonly versionOfTag: (tag: string, name: string) => string | undefined;
  readonly tagPrefixOf: (name: string) => string;
}
interface Run {
  readonly head_sha: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
}
interface CiGate {
  readonly ciVerdictOf: (runs: readonly Run[], sha: string) => string;
  readonly ciGateOptionsOf: (args: readonly string[]) => {
    readonly sha: string;
    readonly workflow: string;
    readonly timeoutMinutes: number;
  };
}
interface PinFramework {
  readonly pinOf: (
    current: Pin,
    args: readonly string[],
    gitHeadOf: (version: string) => string | undefined,
  ) => Pin;
}
const release = (await import(join(repo, "scripts/release/release-plan.mjs"))) as Release;
const gate = (await import(join(repo, "scripts/release/ci-gate.mjs"))) as CiGate;
const pinning = (await import(join(repo, "scripts/pin-framework.mjs"))) as PinFramework;

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const pkg = {
  name: "@agboss/mongodb",
  version: "0.1.1",
  peerDependencies: { "@agboss/core": "^0.1.1" },
};
const releasePin: Pin = { source: "registry", frameworkSha: SHA, version: "0.1.1" };
const problemsOf = (overrides: Partial<Parameters<Release["releaseProblemsOf"]>[0]>) =>
  release
    .releaseProblemsOf({
      tag: "mongodb-v0.1.1",
      pkg,
      pin: releasePin,
      publishedCoreVersions: ["0.1.0", "0.1.1"],
      ...overrides,
    })
    .map((found) => found.problem);

describe("AC2: the release plan", () => {
  it("AC2: the tag of the package's version on the published core it pins is ready", () => {
    expect(problemsOf({})).toEqual([]);
  });

  it("AC2: a tag that is not the package's version is refused", () => {
    expect(problemsOf({ tag: "mongodb-v0.1.2" })).toEqual([
      "the tag mongodb-v0.1.2 is not mongodb-v0.1.1, the package's version",
    ]);
    expect(problemsOf({ tag: "v0.1.1" })).toHaveLength(1);
    expect(release.versionOfTag("mongodb-v0.1.1-rc.1", "@agboss/mongodb")).toBeUndefined();
    // every package of the train after the core tags its releases by its own name
    expect(release.tagPrefixOf("@agboss/mongodb")).toBe("mongodb-v");
    expect(release.versionOfTag("redis-v0.1.1", "@agboss/redis")).toBe("0.1.1");
  });

  it("AC2: a commit pin, an unpublished core or another peer range is refused", () => {
    expect(problemsOf({ pin: { ...releasePin, source: "commit" } })[0]).toMatch(
      /takes @agboss\/core from commit/,
    );
    expect(problemsOf({ publishedCoreVersions: ["0.1.0"] })).toEqual([
      "@agboss/core@0.1.1 is not on npm: publish the core first",
    ]);
    expect(problemsOf({ pkg: { ...pkg, peerDependencies: { "@agboss/core": "^0.1.0" } } })).toEqual(
      ["the peer dependency @agboss/core is ^0.1.0, not ^0.1.1 (the pin)"],
    );
  });

  it("AC3: a dry run reports the release-moment problems and stops only on the others", () => {
    const problems = release.releaseProblemsOf({
      tag: undefined,
      pkg: { ...pkg, version: "0.1" },
      pin: { source: "commit", frameworkSha: SHA, version: "0.1.1" },
      publishedCoreVersions: ["0.1.0"],
    });
    expect(problems).toHaveLength(3);
    expect(release.blockingProblemsOf(problems, { isDryRun: true })).toEqual([
      { problem: "package.json version 0.1 is not X.Y.Z", isReleaseMoment: false },
    ]);
    expect(release.blockingProblemsOf(problems, { isDryRun: false })).toHaveLength(3);
  });
});

describe("AC2: CI on that exact commit", () => {
  const run = (overrides: Partial<Run>): Run => ({
    head_sha: SHA,
    event: "push",
    status: "completed",
    conclusion: "success",
    ...overrides,
  });

  it("AC2: a successful push run of the commit passes; one still running waits", () => {
    expect(gate.ciVerdictOf([run({})], SHA)).toBe("passed");
    expect(gate.ciVerdictOf([run({ status: "in_progress", conclusion: null })], SHA)).toBe(
      "pending",
    );
  });

  it("AC2: a failed run fails; a pull request's, a schedule's or another commit's runs do not count", () => {
    expect(gate.ciVerdictOf([run({ conclusion: "failure" })], SHA)).toBe("failed");
    expect(gate.ciVerdictOf([run({ conclusion: "cancelled" })], SHA)).toBe("failed");
    expect(
      gate.ciVerdictOf(
        [run({ event: "pull_request" }), run({ event: "schedule" }), run({ head_sha: OTHER })],
        SHA,
      ),
    ).toBe("missing");
  });

  it("AC2: the gate takes a full SHA only", () => {
    expect(gate.ciGateOptionsOf(["--sha", SHA])).toEqual({
      sha: SHA,
      workflow: "ci.yml",
      timeoutMinutes: 150,
    });
    expect(() => gate.ciGateOptionsOf(["--sha", "abc"])).toThrow(/full commit SHA/);
    expect(() => gate.ciGateOptionsOf(["--sha", SHA, "--timeout-minutes", "-1"])).toThrow(
      /whole number/,
    );
  });
});

describe("AC2: the pin", () => {
  const commitPin: Pin = {
    repository: "agbossjs/agboss",
    source: "commit",
    frameworkSha: OTHER,
    version: "0.1.0",
  };

  it("AC2: --registry pins the published version at the commit npm recorded", () => {
    expect(pinning.pinOf(commitPin, ["--registry", "0.1.1"], () => SHA)).toEqual({
      repository: "agbossjs/agboss",
      source: "registry",
      frameworkSha: SHA,
      version: "0.1.1",
    });
    expect(pinning.pinOf(commitPin, ["--registry", "0.1.1"], () => undefined).frameworkSha).toBe(
      OTHER,
    );
  });

  it("AC2: --sha pins a commit again; exactly one of the two, each well formed", () => {
    expect(pinning.pinOf({ ...releasePin }, ["--sha", OTHER], () => undefined)).toEqual({
      source: "commit",
      frameworkSha: OTHER,
      version: "0.1.1",
    });
    expect(() => pinning.pinOf(commitPin, [], () => SHA)).toThrow(/one of --sha/);
    expect(() =>
      pinning.pinOf(commitPin, ["--sha", OTHER, "--registry", "0.1.1"], () => SHA),
    ).toThrow(/one of --sha/);
    expect(() => pinning.pinOf(commitPin, ["--registry", "next"], () => SHA)).toThrow(/x\.y\.z/);
    expect(() => pinning.pinOf(commitPin, ["--sha", "abc"], () => SHA)).toThrow(/full commit/);
  });
});
