/**
 * agbossjs/agboss#523 AC2 — `scripts/check-real-time.mjs` (`npm run check:real-time`, in `npm run check`): no test
 * asserts a real-time duration against a fixed threshold, and this repository has none. The planted
 * assertions are built from parts, so this file itself holds none.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repo = new URL("../../", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "agboss-check-real-time-"));

interface CheckRealTime {
  readonly findingsOf: (text: string, file: string) => readonly string[];
}
const { findingsOf } = (await import(join(repo, "scripts/check-real-time.mjs"))) as CheckRealTime;

/** `expect(<argument>).<matcher>(<expected>);` — assembled, never written whole here. */
const assertion = (argument: string, matcher: string, expected: string): string =>
  ["expect(", argument, ").", matcher, "(", expected, ");"].join("");
const found = (...lines: readonly string[]): readonly string[] =>
  findingsOf(`${lines.join("\n")}\n`, "a.test.ts");

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("AC2: a real-time threshold assertion is found", () => {
  it.each([
    [
      "a real time read",
      assertion("Date.now() - started", "toBeLessThan", "2000"),
      "reads the real time",
    ],
    [
      "performance.now()",
      assertion("performance.now() - t", "toBeGreaterThan", "10"),
      "reads the real time",
    ],
    [
      "a duration",
      assertion("call.end - call.start", "toBeGreaterThanOrEqual", "300"),
      "is a difference",
    ],
    [
      "a floor with a separator",
      assertion("end - start", "toBeGreaterThan", "15_000"),
      "is a difference",
    ],
  ])("AC2: %s", (_, line, why) => {
    const [finding] = found(line);

    expect(finding).toContain("a.test.ts:1: expect(");
    expect(finding).toContain(why);
    expect(finding).toContain("assert on the Clock or on the order of events");
  });

  it("AC2: a variable assigned a real time read, compared later", () => {
    const findings = found(
      "const tookMs = Date.now() - killedAt;",
      assertion("tookMs", "toBeLessThan", "70_000"),
    );

    expect(findings).toEqual([expect.stringContaining("a.test.ts:2: expect(tookMs)")]);
    expect(findings[0]).toContain("reads tookMs, a real time read");
  });

  it("AC2: a negated or multi-line assertion too", () => {
    const negated = ["expect(Date.now() - s)", ".not", ".toBeGreaterThan(5);"].join("\n  ");

    expect(found(negated)).toHaveLength(1);
  });

  it("AC2: a time compared with another time plus a fixed duration", () => {
    const findings = found(
      "const startedAt = Date.now();",
      assertion("endedAt", "toBeGreaterThanOrEqual", "startedAt + 300"),
    );

    expect(findings[0]).toContain("is compared with a time plus a fixed duration");
  });
});

describe("AC2: what is not a real-time threshold passes", () => {
  it.each([
    ["the order of two events", assertion("call.start", "toBeGreaterThanOrEqual", "before.end")],
    ["a count", assertion("files.length", "toBeGreaterThan", "200")],
    ["a time read against 0", assertion("Date.now()", "toBeGreaterThan", "0")],
    ["a sum that is no time", assertion("spent", "toBeLessThanOrEqual", "5 * 0.4 + 1e-9")],
    ["a count plus one", assertion("cases.length", "toBeGreaterThanOrEqual", "before + 1")],
    ["an equality on a duration", assertion("end - start", "toBe", "300")],
  ])("AC2: %s", (_, line) => {
    expect(found(line)).toEqual([]);
  });
});

describe("AC2: the command", () => {
  const checkRealTime = (root: string) =>
    spawnSync(process.execPath, [join(repo, "scripts/check-real-time.mjs"), root], {
      encoding: "utf8",
    });

  it("AC2: this repository's tests assert no real-time threshold, exit 0", () => {
    const ran = checkRealTime(repo);

    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
  });

  it("AC2: a planted one fails, exit 1, naming the file and line", () => {
    mkdirSync(join(scratch, "tests"), { recursive: true });
    writeFileSync(
      join(scratch, "tests", "slow.test.ts"),
      `\n${assertion("Date.now() - started", "toBeLessThan", "2000")}\n`,
    );
    writeFileSync(
      join(scratch, "tests", "helper.ts"),
      assertion("Date.now() - s", "toBeLessThan", "9"),
    );

    const ran = checkRealTime(scratch);

    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("tests/slow.test.ts:2: expect(Date.now() - started)");
    expect(ran.stderr).not.toContain("helper.ts");
    expect(ran.stderr).toContain("check:real-time: 1 real-time threshold assertion(s)");
  });
});
