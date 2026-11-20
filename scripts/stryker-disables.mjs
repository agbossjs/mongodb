#!/usr/bin/env node
// One equivalent mutant per Stryker disable (#1353, #619). A `Stryker disable` is allowed only when every mutant
// under it is equivalent, and a comment that hides two mutants hides the one that is not (a `true` beside a
// `false`, a `>=` beside a `<=`, a regex's anchor beside its class). The instrumenter Stryker itself runs
// finds the mutants, so the answer is the one a mutation run gets, in under a second and without a run:
//   - rule A: every disable is `// Stryker disable next-line <Mutator>: <reason>` — one mutator, a reason;
//     no `disable all`, no ranges, no `restore`;
//   - rule B: each disable ignores exactly one mutant, on the line after it (none: the disable is stale or
//     names a mutator that line has none of; two or more: one of them is not what the reason argues);
//   - rule C: the ignored mutants of a file are the disables of the file, nothing ignored without a comment.
// Self-contained, with no repo-specific paths beyond `DEFAULT_DIRS`: the stores copy it as it is.
// `node scripts/stryker-disables.mjs [dir ...]` checks the given source dirs or files (default: every `packages/*/src`, or `src`).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Instrumenter } from "@stryker-mutator/instrumenter";

const SKIP = new Set(["node_modules", "dist", "coverage"]);
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const MENTION = /Stryker\s+(?:disable|restore)/;
const ALLOWED = /^\s*\/\/ Stryker disable next-line ([A-Za-z]+): \S/;

/** The instrumenter's logger: nothing is printed, a warning is kept (an unknown mutator's name is one). */
const loggerOf = (warnings) => {
  const quiet = () => undefined;
  return {
    warn: (message) => warnings.push(String(message)),
    debug: quiet,
    info: quiet,
    error: quiet,
    trace: quiet,
    fatal: quiet,
    isDebugEnabled: () => false,
    isTraceEnabled: () => false,
    isInfoEnabled: () => false,
    isWarnEnabled: () => true,
    isErrorEnabled: () => false,
    isFatalEnabled: () => false,
  };
};

/**
 * The violations of `files` (`{ name, content }`), as `name:line: what is wrong` lines; empty when every
 * disable hides exactly one mutant. Files that never mention a Stryker directive are not parsed.
 * @param {readonly { name: string, content: string }[]} files
 * @returns {Promise<string[]>}
 */
export async function auditDisables(files) {
  const problems = [];
  for (const { name, content } of files) {
    if (!MENTION.test(content)) continue;
    const lines = content.split("\n");
    const disables = [];
    lines.forEach((text, index) => {
      if (!MENTION.test(text)) return;
      const line = index + 1;
      const allowed = ALLOWED.exec(text);
      if (allowed === null)
        problems.push(
          `${name}:${String(line)}: only "// Stryker disable next-line <Mutator>: <reason>" is allowed (no "all", no ranges, no restore, one mutator, a reason)`,
        );
      else disables.push({ line, mutator: allowed[1] });
    });
    const warnings = [];
    const { mutants } = await new Instrumenter(loggerOf(warnings)).instrument(
      [{ name, content, mutate: true }],
      { excludedMutations: [], ignorers: [], plugins: null },
    );
    for (const warning of warnings) problems.push(`${name}: ${warning}`);
    const ignored = mutants.filter((mutant) => mutant.statusReason !== undefined);
    // the API's locations count lines from 0
    const lineOf = (mutant) => mutant.location.start.line + 1;
    const under = (line) => ignored.filter((mutant) => lineOf(mutant) === line);
    for (const { line, mutator } of disables) {
      const hidden = under(line + 1);
      if (hidden.length === 0)
        problems.push(
          `${name}:${String(line)}: stale — no ${mutator} mutant starts on line ${String(line + 1)}`,
        );
      else if (hidden.length > 1)
        problems.push(
          `${name}:${String(line)}: hides ${String(hidden.length)} mutants on line ${String(line + 1)} (${hidden
            .map((mutant) => `${mutant.mutatorName} -> ${mutant.replacement}`)
            .join("; ")}); rewrite the code so exactly one equivalent mutant is left under it`,
        );
    }
    if (ignored.length !== disables.length) {
      const anchored = new Set(disables.map(({ line }) => line + 1));
      for (const mutant of ignored)
        if (!anchored.has(lineOf(mutant)))
          problems.push(
            `${name}:${String(lineOf(mutant))}: a ${mutant.mutatorName} mutant is ignored without a "Stryker disable next-line" above it`,
          );
    }
  }
  return problems;
}

function* sourcesOf(dir) {
  if (statSync(dir).isFile()) {
    yield dir;
    return;
  }
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sourcesOf(path);
    else if (SOURCE.test(entry)) yield path;
  }
}

/** The source dirs a repo mutates: every `packages/<name>/src`, or `src` of a single package. */
export function defaultDirs(root) {
  const packages = join(root, "packages");
  const dirs = existsSync(packages)
    ? readdirSync(packages).map((name) => join(packages, name, "src"))
    : [];
  return [...dirs, join(root, "src")].filter((dir) => existsSync(dir));
}

/** The violations of every source file under `dirs` (relative to `root` in the messages). */
export function auditDirs(root, dirs) {
  const files = dirs.flatMap((dir) => [...sourcesOf(dir)]);
  return auditDisables(
    files.map((path) => ({ name: relative(root, path), content: readFileSync(path, "utf8") })),
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const given = process.argv.slice(2);
  const problems = await auditDirs(root, given.length > 0 ? given : defaultDirs(root));
  if (problems.length > 0) {
    console.error(
      `Stryker disables (#1353) — one equivalent mutant per disable:\n  ${problems.join("\n  ")}`,
    );
    process.exit(1);
  }
  console.log("Stryker disables: each hides exactly one mutant");
}
