#!/usr/bin/env node
// A copy of agbossjs/agboss scripts/check-real-time.mjs (#523): keep the two alike.
// No test asserts a real-time duration against a fixed threshold (#523, after #509): on a loaded
// runner a 300 ms floor measures 299 ms, a 2 s ceiling 2.1 s. A test asserts on the `Clock` (a
// `VirtualClock` it advances), on the order of events, or not at all — a "never hangs" bound is the
// test's own timeout. Fails on a comparison matcher (`toBeGreaterThan`, `toBeLessThan`, their
// `OrEqual`s) against a number literal other than 0 whose `expect(…)` subtracts (`end - start`),
// reads the real time (`Date.now()`, `performance.now()`, `process.hrtime`) or names a variable a
// real time read was assigned to — and on one whose expected value adds a number to something
// (`toBeGreaterThanOrEqual(before.end + 300)`). Scans every `*.test.*` / `*.spec.*` file.
// `npm run check:real-time`, part of `make check`. Exit 0 clean, 1 with every finding listed.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SKIP = new Set(["node_modules", "dist", "coverage", ".agboss", ".agboss-source", ".packed"]);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const REAL_TIME = /\bDate\.now\(|\bperformance\.now\(|\bprocess\.hrtime\b/u;
const NUMBER = /^-?\d[\d_]*(?:\.\d+)?(?:e\d+)?$/u;
/** `expect(<argument, two levels of parentheses>)[.not].<comparison>(<expected>)`. */
const COMPARISON =
  /expect\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)\s*(?:\.\s*not\s*)?\.\s*(toBe(?:Greater|Less)Than(?:OrEqual)?)\s*\(\s*([^()]*?)\s*,?\s*\)/gu;
/** `const|let|var <name> = <expression up to the end of the statement>`. */
const ASSIGNMENT = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^;\n]+)/gu;

/** The names a real time read is assigned to in `text`. */
function realTimeNames(text) {
  const names = new Set();
  for (const [, name, expression] of text.matchAll(ASSIGNMENT))
    if (REAL_TIME.test(expression)) names.add(name);
  return names;
}

/** Why the argument of a comparison against a number measures real time, or undefined. */
function measuredTime(argument, names) {
  if (/[\w$)\]]\s+-\s+[\w$(]/u.test(argument) && timeRead(argument, names) === undefined)
    return "is a difference (a duration)";
  return timeRead(argument, names);
}

/** Why an expression reads the real time — directly or through a name assigned one —, or undefined. */
function timeRead(expression, names) {
  if (REAL_TIME.test(expression)) return "reads the real time";
  const named = [...names].find((name) =>
    new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, "u").test(expression),
  );
  return named === undefined ? undefined : `reads ${named}, a real time read`;
}

/** Why one comparison is a real-time threshold, or undefined. */
function thresholdOf(argument, expected, names) {
  const offset = /^(.*[\w$)\]])\s*[+-]\s*\d[\d_]*\s*$/u.exec(expected);
  if (offset !== null) {
    const base = offset[1] ?? "";
    const isTime = [argument, base].some((side) => timeRead(side, names) !== undefined);
    return isTime ? "is compared with a time plus a fixed duration" : undefined;
  }
  if (!NUMBER.test(expected) || Number(expected.replaceAll("_", "")) === 0) return undefined;
  return measuredTime(argument, names);
}

/** Every real-time threshold assertion of one test file's text: `file:line: …`. */
export function findingsOf(text, file) {
  const names = realTimeNames(text);
  const findings = [];
  for (const match of text.matchAll(COMPARISON)) {
    const [, argument, matcher, expected] = match;
    const why = thresholdOf(argument, expected, names);
    if (why === undefined) continue;
    const line = text.slice(0, match.index).split("\n").length;
    findings.push(
      `${file}:${String(line)}: expect(${argument.trim()}).${matcher}(${expected}) — the argument ${why}: ` +
        "assert on the Clock or on the order of events, not on real elapsed time",
    );
  }
  return findings;
}

function* testFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".git")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* testFiles(path);
    else if (TEST_FILE.test(name)) yield path;
  }
}

/** Every finding in the test files under `root`. */
export function problemsOf(root) {
  const findings = [];
  for (const path of testFiles(root))
    findings.push(...findingsOf(readFileSync(path, "utf8"), relative(root, path)));
  return findings;
}

function main(args) {
  const root = resolve(args[0] ?? new URL("..", import.meta.url).pathname);
  const findings = problemsOf(root);
  for (const finding of findings) console.error(finding);
  if (findings.length > 0) {
    console.error(`check:real-time: ${String(findings.length)} real-time threshold assertion(s)`);
    return 1;
  }
  console.log("check:real-time: no test asserts a real-time duration against a fixed threshold");
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === new URL(import.meta.url).pathname)
  process.exitCode = main(process.argv.slice(2));
