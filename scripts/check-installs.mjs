#!/usr/bin/env node
// A copy of agbossjs/agboss scripts/check-installs.mjs (#523): keep the two alike.
// No CI install takes a release nobody reviewed (#523). Fails on:
//   - a workflow step (`.github/workflows/*.yml`) that installs by resolving ranges — `npm install`,
//     `npm i`, `npm add`, `npm update` — without `--before`: a workflow installs from the lockfile,
//     `npm ci`;
//   - a workflow's `npx <package>` / `npm exec <package>` not pinned to an exact version
//     (`npx tsx@4.20.3`): an unpinned one downloads whatever is newest;
//   - a script (`scripts/**/*.mjs`) that passes `"install"` to npm itself, or runs `"npx"`: its
//     install arguments come from `rangeInstallArguments()` (`scripts/npm-before.mjs`, the
//     minimum release age) and a local tool runs from `node_modules/.bin` (its `*.test.mjs` aside).
// `npm run check:installs`, part of `make check`. Exit 0 clean, 1 with every problem listed.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** The npm subcommands that resolve ranges. */
const RESOLVING = new Set(["install", "i", "in", "add", "update", "up", "upgrade"]);
/** `name@1.2.3` or `@scope/name@1.2.3`, a prerelease allowed: an exact version. */
const EXACT = /^(?:@[^/\s]+\/)?[^@\s/]+@\d+\.\d+\.\d+(?:-[\w.]+)?$/u;
/** The files a script check skips: the helper and this guard name what they forbid. */
const SCRIPT_EXEMPT = new Set(["scripts/npm-before.mjs", "scripts/check-installs.mjs"]);

/** The words of one shell command line, comments dropped. */
function wordsOf(line) {
  return line
    .replace(/(^|\s)#.*$/u, "")
    .split(/[\s;&|()]+/u)
    .filter(Boolean);
}

/** npm options whose value is the next word (`npm --prefix dir install`). */
const VALUED = new Set(["--prefix", "-C", "--workspace", "-w", "--cache", "--registry"]);

/** The first word after `from` that is neither an option nor a valued option's value. */
function positionalAfter(words, from) {
  for (let at = from; at < words.length; at++) {
    if (VALUED.has(words[at])) at++;
    else if (!words[at].startsWith("-")) return at;
  }
  return -1;
}

/** What is wrong with one npm command whose words start at `at` (`npm …`), or undefined. */
function npmProblem(words, at) {
  const sub = positionalAfter(words, at + 1);
  if (sub === -1) return undefined;
  if (RESOLVING.has(words[sub])) {
    return words.slice(sub).some((word) => word.startsWith("--before"))
      ? undefined
      : `npm ${words[sub]} resolves ranges: use npm ci (or --before, the minimum release age)`;
  }
  if (words[sub] === "exec" || words[sub] === "x") return execProblem(words, sub);
  return undefined;
}

/** What is wrong with an `npx …` / `npm exec …` whose words start at `at`, or undefined. */
function execProblem(words, at) {
  const packageOption = words.slice(at + 1).find((word) => word.startsWith("--package="));
  const spec = packageOption?.slice("--package=".length) ?? words[positionalAfter(words, at + 1)];
  if (spec === undefined || spec === "--") return undefined;
  return EXACT.test(spec) ? undefined : `${spec} is not pinned to an exact version (name@x.y.z)`;
}

/** Every problem of one workflow's text: `file:line: …`. */
export function workflowProblems(text, file) {
  const problems = [];
  for (const [index, line] of text.split("\n").entries()) {
    const words = wordsOf(line);
    for (const [at, word] of words.entries()) {
      const problem =
        word === "npm"
          ? npmProblem(words, at)
          : word === "npx"
            ? execProblem(words, at)
            : undefined;
      if (problem !== undefined) problems.push(`${file}:${String(index + 1)}: ${problem}`);
    }
  }
  return problems;
}

/** Every problem of one script's text: `file:line: …`. */
export function scriptProblems(text, file) {
  const problems = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (/["'`]install["'`]/u.test(line))
      problems.push(
        `${file}:${String(index + 1)}: an npm install's arguments come from rangeInstallArguments()`,
      );
    if (/["'`]npx["'`]/u.test(line))
      problems.push(
        `${file}:${String(index + 1)}: run a local tool from node_modules/.bin, not npx`,
      );
  }
  return problems;
}

function* filesUnder(dir, matches) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* filesUnder(path, matches);
    else if (matches(name)) yield path;
  }
}

/** Every problem in the workflows and scripts of the repository at `root`. */
export function problemsOf(root) {
  const problems = [];
  const workflows = join(root, ".github", "workflows");
  for (const path of filesUnder(workflows, (name) => /\.ya?ml$/u.test(name)))
    problems.push(...workflowProblems(readFileSync(path, "utf8"), relative(root, path)));
  // a script's own tests (`*.test.mjs`) plant what the check forbids
  const isScript = (name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs");
  for (const path of filesUnder(join(root, "scripts"), isScript)) {
    const file = relative(root, path);
    if (!SCRIPT_EXEMPT.has(file))
      problems.push(...scriptProblems(readFileSync(path, "utf8"), file));
  }
  return problems;
}

function main(args) {
  const root = resolve(args[0] ?? new URL("..", import.meta.url).pathname);
  const problems = problemsOf(root);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`check:installs: ${String(problems.length)} unreviewed install(s)`);
    return 1;
  }
  console.log(
    "check:installs: every CI install is from a lockfile, a minimum release age or a pin",
  );
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === new URL(import.meta.url).pathname)
  process.exitCode = main(process.argv.slice(2));
