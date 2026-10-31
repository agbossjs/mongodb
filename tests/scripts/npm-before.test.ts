/**
 * agbossjs/agboss#523 AC1 — an install that resolves ranges takes no release younger than three
 * days: `scripts/npm-before.mjs` builds `npm install --before=<now − 3 days>` (`AGBOSS_NPM_BEFORE`
 * overrides the date), and `install:packed` / `install:published` install with it.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = new URL("../../", import.meta.url).pathname;

type Environment = Readonly<Record<string, string | undefined>>;
type InstallArguments = (env: Environment, now: Date) => readonly string[];
interface NpmBefore {
  readonly MINIMUM_RELEASE_AGE_DAYS: number;
  readonly NpmBeforeError: new (message: string) => Error;
  readonly npmBeforeOf: (env: Environment, now: Date) => string;
  readonly rangeInstallArguments: (
    rest: readonly string[],
    env: Environment,
    now: Date,
  ) => readonly string[];
}
const npmBefore = (await import(join(repo, "scripts/npm-before.mjs"))) as NpmBefore;
const { packedInstallArguments } = (await import(join(repo, "scripts/install-packed.mjs"))) as {
  readonly packedInstallArguments: InstallArguments;
};
const { publishedInstallArguments } = (await import(
  join(repo, "scripts/install-published.mjs")
)) as { readonly publishedInstallArguments: InstallArguments };

const NOW = new Date("2026-10-31T12:00:00.000Z");
const THREE_DAYS_BACK = "--before=2026-10-28T12:00:00.000Z";

describe("AC1: the minimum release age of an install that resolves ranges", () => {
  it("AC1: is three days: --before is now minus three days when nothing overrides it", () => {
    expect(npmBefore.MINIMUM_RELEASE_AGE_DAYS).toBe(3);
    expect(npmBefore.npmBeforeOf({}, NOW)).toBe("2026-10-28T12:00:00.000Z");
  });

  it("AC1: an empty AGBOSS_NPM_BEFORE is unset", () => {
    expect(npmBefore.npmBeforeOf({ AGBOSS_NPM_BEFORE: "" }, NOW)).toBe("2026-10-28T12:00:00.000Z");
  });

  it("AC1: AGBOSS_NPM_BEFORE overrides the date", () => {
    expect(npmBefore.npmBeforeOf({ AGBOSS_NPM_BEFORE: "2026-10-31T11:59:00Z" }, NOW)).toBe(
      "2026-10-31T11:59:00.000Z",
    );
  });

  it("AC1: an AGBOSS_NPM_BEFORE that is not a date fails, naming the variable", () => {
    expect(() => npmBefore.npmBeforeOf({ AGBOSS_NPM_BEFORE: "soon" }, NOW)).toThrow(
      npmBefore.NpmBeforeError,
    );
    expect(() => npmBefore.npmBeforeOf({ AGBOSS_NPM_BEFORE: "soon" }, NOW)).toThrow(
      "AGBOSS_NPM_BEFORE=soon is not a date",
    );
  });

  it("AC1: the arguments are install, --before, then the rest in order", () => {
    expect(npmBefore.rangeInstallArguments(["a.tgz"], {}, NOW)).toEqual([
      "install",
      THREE_DAYS_BACK,
      "a.tgz",
    ]);
  });
});

describe("AC1: install:packed and install:published install with the minimum release age", () => {
  it.each([
    ["install:packed", packedInstallArguments],
    ["install:published", publishedInstallArguments],
  ])("AC1: %s: no lockfile written, nothing younger than three days", (_, argumentsOf) => {
    expect(argumentsOf({}, NOW)).toEqual([
      "install",
      THREE_DAYS_BACK,
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
    ]);
  });

  it.each([
    ["install:packed", packedInstallArguments],
    ["install:published", publishedInstallArguments],
  ])("AC1: %s: AGBOSS_NPM_BEFORE reaches its install", (_, argumentsOf) => {
    expect(argumentsOf({ AGBOSS_NPM_BEFORE: "2026-10-31T12:00:00Z" }, NOW)[1]).toBe(
      "--before=2026-10-31T12:00:00.000Z",
    );
  });
});
