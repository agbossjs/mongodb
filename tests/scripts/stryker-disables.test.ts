/**
 * agbossjs/agboss#1353 (the core's test, ported): `scripts/stryker-disables.mjs` lets a `Stryker disable` hide exactly one mutant (#619): a
 * fixture with a second mutant under a disable fails it, as do a range, a disable that hides
 * nothing and one that does not sit above its code.
 */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runProcess } from "../support/process.js";

const repo = new URL("../../", import.meta.url).pathname;
const script = join(repo, "scripts/stryker-disables.mjs");

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "stryker-disables-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The script on a folder holding `files` (name → source): its exit code and what it said. */
async function checked(
  files: Record<string, string>,
): Promise<{ code: number | null; said: string }> {
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(join(dir, name), source);
  const run = await runProcess("node", [script, dir]);
  return { code: run.status, said: run.stdout + run.stderr };
}

const ONE = [
  "export const keyOf = (id: string | undefined): string =>",
  "  // Stryker disable next-line StringLiteral: an id that is not there keys the same as an empty one",
  '  id ?? "";',
  "",
].join("\n");

describe("scripts/stryker-disables.mjs", () => {
  it("passes a disable that hides one mutant, and a file with none", async () => {
    const run = await checked({ "one.ts": ONE, "none.ts": "export const a = 1 + 2;\n" });

    expect(run.said).toContain("each hides exactly one mutant");
    expect(run.code).toBe(0);
  });

  it("fails a second mutant planted under a disable, naming the line and the mutants", async () => {
    const planted = [
      "export const keyOf = (id: string | undefined): string =>",
      "  // Stryker disable next-line StringLiteral: an id that is not there keys the same as an empty one",
      '  `${id ?? ""}:${"tenant"}`;',
      "",
    ].join("\n");

    const run = await checked({ "planted.ts": planted });

    expect(run.code).toBe(1);
    expect(run.said).toMatch(/planted\.ts:2: hides [2-9] mutants on line 3/);
  });

  it("fails a disable that hides nothing: no such mutant on the next line", async () => {
    const stale = [
      "// Stryker disable next-line StringLiteral: there is no string here",
      "export const a = 1 + 2;",
      "",
    ].join("\n");

    const run = await checked({ "stale.ts": stale });

    expect(run.code).toBe(1);
    expect(run.said).toMatch(/stale\.ts:1: stale — no StringLiteral mutant starts on line 2/);
  });

  it.each([
    ["disable all", "// Stryker disable all: not a mutant is looked at"],
    ["a range", "// Stryker disable StringLiteral: the whole file below"],
    ["a restore", "// Stryker restore StringLiteral"],
    ["two mutators", "// Stryker disable next-line StringLiteral,BooleanLiteral: two at once"],
    ["no reason", "// Stryker disable next-line StringLiteral"],
    ["a block comment", "/* Stryker disable next-line StringLiteral: not a line comment */"],
  ])("fails %s", async (_name, comment) => {
    const run = await checked({ "syntax.ts": `${comment}\nexport const a = "x";\n` });

    expect(run.code).toBe(1);
    expect(run.said).toMatch(
      /syntax\.ts:1: only "\/\/ Stryker disable next-line <Mutator>: <reason>"/,
    );
  });

  it("fails a disable parted from its code by a blank line: it hides nothing", async () => {
    const apart = [
      "// Stryker disable next-line StringLiteral: a blank line parts it from its code",
      "",
      'export const a = "x";',
      "",
    ].join("\n");

    const run = await checked({ "apart.ts": apart });

    expect(run.code).toBe(1);
    expect(run.said).toMatch(/apart\.ts:1: stale — no StringLiteral mutant starts on line 2/);
  });

  it("reports every file's problems in one run", async () => {
    const run = await checked({
      "a.ts": "// Stryker disable all: x\nexport const a = 1;\n",
      "b.ts": "// Stryker disable next-line StringLiteral: x\nexport const b = 1;\n",
    });

    expect(run.said).toContain("a.ts:1");
    expect(run.said).toContain("b.ts:1");
  });
});
