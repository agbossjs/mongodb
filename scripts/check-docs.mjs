#!/usr/bin/env node
/**
 * Docs that compile (agbossjs/agboss#196, the core's scripts/check-docs.mjs for a store,
 * agbossjs/agboss#1213), after the build:
 *   1. every ```ts block of the docs typechecks against the built package (`dist`, as the
 *      package's own name) and the installed `@agboss/core`, with the core's conventions
 *      (`scripts/docs/snippets.mjs`): ```ts file=<path> is written at that path for the other
 *      blocks to import, ```ts no-check: <reason> is skipped (the reason required), and a
 *      `<!-- snippet-context … -->` comment right before a fence gives the hidden lines around it;
 *   2. every `npm run <script>` the docs name is a script of package.json, and every `scripts/…`
 *      file they name exists.
 * Exit 0 clean, 1 with every problem listed. `npm run check:docs`, part of `npm run check:static`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { conventionProblems, snippetsOf, sourceOf } from "./docs/snippets.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DOCS = ["README.md", "CONTRIBUTING.md", "CLAUDE.md", "AGENTS.md"];
const OUT = join(ROOT, "temp", "check-docs");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** The `npm run …` scripts and `scripts/…` files one doc names that do not exist. */
export function referenceProblemsOf(doc, text, scripts = pkg.scripts, exists = existsSync) {
  const problems = [];
  for (const [index, line] of text.split("\n").entries()) {
    for (const [, name] of line.matchAll(/npm run ([\w:-]+)/gu))
      if (scripts[name] === undefined)
        problems.push(`${doc}:${index + 1}: npm run ${name} is no script of package.json`);
    for (const [path] of line.matchAll(/(?<![\w/.])scripts\/[\w./-]+\.(?:mjs|js|sh)/gu))
      if (!exists(join(ROOT, path))) problems.push(`${doc}:${index + 1}: ${path} does not exist`);
  }
  return problems;
}

/** Writes the doc's snippets that compile or are imported; the compiled ones, with their place. */
export function writeSnippets(doc, snippets, out = OUT) {
  const written = [];
  for (const snippet of snippets) {
    if (!snippet.compiled && snippet.file === undefined) continue;
    const name = snippet.file ?? `snippet-line-${String(snippet.line)}.ts`;
    const path = join(out, doc.replace(/\W/gu, "-"), name);
    mkdirSync(dirname(path), { recursive: true });
    const { text, offset } = sourceOf(snippet);
    writeFileSync(path, snippet.file === undefined ? `${text}export {};\n` : text);
    if (snippet.compiled) written.push({ path, doc, line: snippet.line, offset });
  }
  return written;
}

/** Each compiler diagnostic `path(line,col): …` of a written snippet mapped to its doc's line. */
export function mappedOf(output, written) {
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const at = /^(.+?)\((\d+),\d+\): (.*)$/u.exec(line);
      const file = at && written.find((one) => one.path.endsWith(at[1]));
      if (!at || !file) return line;
      return `${file.doc}:${String(file.line + Number(at[2]) - 1 - file.offset)}: ${at[3]}`;
    });
}

/** Typechecks the written snippets, each a module of its own; the compiler's errors mapped. */
function typecheck(written) {
  const config = {
    extends: "../../tsconfig.base.json",
    compilerOptions: { noEmit: true, paths: { [pkg.name]: ["../../dist/index.d.ts"] } },
    files: written.map((file) => file.path),
  };
  writeFileSync(join(OUT, "tsconfig.json"), JSON.stringify(config));
  try {
    execFileSync(join(ROOT, "node_modules/.bin/tsc"), ["-p", OUT], { cwd: OUT, encoding: "utf8" });
    return [];
  } catch (error) {
    return mappedOf(String(error.stdout ?? error), written);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const problems = [];
  const written = [];
  for (const doc of DOCS.filter((name) => existsSync(join(ROOT, name)))) {
    const text = readFileSync(join(ROOT, doc), "utf8");
    const snippets = snippetsOf(text, doc);
    problems.push(...conventionProblems(snippets), ...referenceProblemsOf(doc, text));
    written.push(...writeSnippets(doc, snippets));
  }
  if (written.length > 0) problems.push(...typecheck(written));
  rmSync(OUT, { recursive: true, force: true });
  if (problems.length > 0) {
    console.error(`check:docs:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`check:docs: ${String(written.length)} ts blocks compile, every reference exists`);
}
