/**
 * agbossjs/agboss#1213 — `scripts/check-docs.mjs` (`npm run check:docs`, in `npm run check:static`):
 * the docs' ts blocks compile against the built package (the core's snippet conventions:
 * `file=`, `no-check: <reason>`, `<!-- snippet-context -->`), and every `npm run …` / `scripts/…`
 * they name exists. The planted fences are built from parts.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runNode } from "../support/process.js";

const repo = new URL("../../", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "agboss-check-docs-"));

interface Written {
  readonly path: string;
  readonly doc: string;
  readonly line: number;
  readonly offset: number;
}
interface CheckDocs {
  readonly referenceProblemsOf: (
    doc: string,
    text: string,
    scripts: Readonly<Record<string, string>>,
    exists: (path: string) => boolean,
  ) => readonly string[];
  readonly writeSnippets: (doc: string, snippets: readonly unknown[], out: string) => Written[];
  readonly mappedOf: (output: string, written: readonly Written[]) => readonly string[];
}
interface Snippets {
  readonly snippetsOf: (markdown: string, doc: string) => readonly unknown[];
  readonly conventionProblems: (snippets: readonly unknown[]) => readonly string[];
}
const docs = (await import(join(repo, "scripts/check-docs.mjs"))) as CheckDocs;
const { snippetsOf, conventionProblems } = (await import(
  join(repo, "scripts/docs/snippets.mjs")
)) as Snippets;
const FENCE = "`".repeat(3);
const doc = (...lines: readonly string[]): string => `${lines.join("\n")}\n`;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("check:docs (agbossjs/agboss#1213)", () => {
  it("writes a ts block with its hidden context, and maps a diagnostic back to the doc's line", () => {
    const markdown = doc(
      "text",
      "<!-- snippet-context",
      "declare const amount: number;",
      "-->",
      `${FENCE}ts`,
      "const twice = amount * 2;",
      "const wrong: string = twice;",
      FENCE,
    );
    const written = docs.writeSnippets("A.md", snippetsOf(markdown, "A.md"), scratch);
    expect(written).toHaveLength(1);
    const [only] = written;
    expect(readFileSync(only?.path ?? "", "utf8")).toBe(
      "declare const amount: number;\nconst twice = amount * 2;\nconst wrong: string = twice;\nexport {};\n",
    );
    const output = `A-md/snippet-line-6.ts(3,7): error TS2322: no.\n`;
    expect(docs.mappedOf(output, written)).toEqual(["A.md:7: error TS2322: no."]);
  });

  it("writes a file= block at its path without compiling it alone", () => {
    const markdown = doc(`${FENCE}ts file=env.ts`, "export const a = 1;", FENCE);
    const written = docs.writeSnippets("B.md", snippetsOf(markdown, "B.md"), scratch);
    expect(written).toHaveLength(1);
    expect(readFileSync(join(scratch, "B-md/env.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("skips a block marked no-check with a reason, and refuses one without", () => {
    const markdown = doc(
      `${FENCE}ts no-check: a peer`,
      "x",
      FENCE,
      `${FENCE}ts no-check`,
      "y",
      FENCE,
    );
    const snippets = snippetsOf(markdown, "C.md");
    expect(docs.writeSnippets("C.md", snippets, scratch)).toEqual([]);
    expect(conventionProblems(snippets)).toEqual([
      "C.md:4: `no-check` needs a reason (no-check: <why>)",
    ]);
  });

  it("names an npm script and a scripts/ file that do not exist", () => {
    const problems = docs.referenceProblemsOf(
      "D.md",
      doc("run npm run check and npm run nope", "see scripts/gone.mjs and scripts/here.mjs"),
      { check: "x" },
      (path) => path.endsWith("here.mjs"),
    );
    expect(problems).toEqual([
      "D.md:1: npm run nope is no script of package.json",
      "D.md:2: scripts/gone.mjs does not exist",
    ]);
  });

  it("this repository's docs pass, exit 0", async () => {
    const ran = await runNode([join(repo, "scripts/check-docs.mjs")]);
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
  }, 120_000);
});
