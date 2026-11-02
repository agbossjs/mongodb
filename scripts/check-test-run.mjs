#!/usr/bin/env node
// A gate run never passes without the tests it is meant to run (agbossjs/agboss#630). Runs a vitest command with
// its JSON report, then holds the report against the projects `--expect <file>` declares — each a
// `name`, `include` / `exclude` globs (relative to that file) and `minFiles`: every file of every
// project ran at least one test, and each project's globs match at least `minFiles` files.
//
//   node scripts/check-test-run.mjs --expect test-run.json -- vitest run --coverage
//
// Why: vitest 3's forks pool runs a `singleFork` project only after every other file of the pool
// settled, and one fork whose run rejects — a test holding its event loop 60 s times out birpc's
// `onTaskUpdate` — makes it skip that project whole: run 41261656814 reported "587 passed (587)"
// with not one file of `tests/faults/`. A moved folder or a drifted glob drops files with no error
// at all. Exit: the command's own code when it failed, else 1 when a project did not run whole,
// 0 when it did; 2 on a usage error.
import { spawn } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const USAGE =
  "usage: node scripts/check-test-run.mjs --expect <test-run.json> -- <vitest command…>";

/** A test that ran: one that passed or failed (skipped, todo and pending ran nothing). */
const RAN = new Set(["passed", "failed"]);

export class UsageError extends Error {}

/** The files of `project` under `root`: its `include` minus its `exclude`, sorted, relative. */
export function expectedFilesOf(project, root) {
  const matched = (patterns) =>
    new Set((patterns ?? []).flatMap((p) => globSync(p, { cwd: root })));
  const excluded = matched(project.exclude);
  return [...matched(project.include)]
    .filter((file) => !excluded.has(file))
    .map((file) => file.split("\\").join("/"))
    .sort();
}

/** The files of `report` (absolute paths) that ran at least one test, relative to `root`. */
function filesThatRan(report, root) {
  return new Set(
    report.testResults
      .filter((file) => file.assertionResults.some((test) => RAN.has(test.status)))
      .map((file) => relative(root, file.name).split("\\").join("/")),
  );
}

/** What is wrong with one project's run, if anything. */
function projectProblems(project, root, ran) {
  const expected = expectedFilesOf(project, root);
  const problems = [];
  const notRun = expected.filter((file) => !ran.has(file));
  if (notRun.length > 0) {
    const count = `${expected.length - notRun.length} of its ${expected.length} test files ran`;
    problems.push(`${project.name}: ${count} — not run: ${notRun.join(", ")}`);
  }
  if (expected.length < project.minFiles) {
    const globs = project.include.join(", ");
    problems.push(
      `${project.name}: ${expected.length} files match ${globs}, fewer than its minFiles ${project.minFiles}`,
    );
  }
  return problems;
}

/** Every problem of a run: `report` is vitest's JSON report, `undefined` when none was written. */
export function testRunProblems({ report, projects, root }) {
  if (report === undefined) return ["no vitest JSON report: the run ended before it was written"];
  const ran = filesThatRan(report, root);
  return projects.flatMap((project) => projectProblems(project, root, ran));
}

/** `--expect <file> -- <command…>` → the expectations file and the command. */
export function parseArguments(args) {
  const separator = args.indexOf("--");
  const own = separator === -1 ? args : args.slice(0, separator);
  const command = separator === -1 ? [] : args.slice(separator + 1);
  const at = own.indexOf("--expect");
  const expect = at === -1 ? undefined : own[at + 1];
  if (expect === undefined) throw new UsageError("--expect <test-run.json> is required");
  if (command.length === 0) throw new UsageError("the vitest command goes after --");
  return { expect, command };
}

/** The reporters vitest would pick on its own (the GitHub annotations kept), plus JSON. */
function reporterArguments(reportFile) {
  const github = process.env.GITHUB_ACTIONS === "true" ? ["--reporter=github-actions"] : [];
  return ["--reporter=default", ...github, "--reporter=json", `--outputFile.json=${reportFile}`];
}

/** Runs `command` with the reporters added, stdio inherited; resolves its exit code. */
function run(command, reportFile) {
  const [executable, ...args] = command;
  return new Promise((done, fail) => {
    const child = spawn(executable, [...args, ...reporterArguments(reportFile)], {
      stdio: "inherit",
    });
    child.once("error", fail);
    child.once("close", (code, signal) => done(code ?? (signal === null ? 1 : 128)));
  });
}

function readReport(reportFile) {
  try {
    return JSON.parse(readFileSync(reportFile, "utf8"));
  } catch {
    return undefined;
  }
}

/** The line a whole run prints: each project's files that ran. */
function summaryOf(projects, root, report) {
  const ran = filesThatRan(report, root);
  const counts = projects.map((project) => {
    const expected = expectedFilesOf(project, root);
    return `${project.name} ${expected.filter((file) => ran.has(file)).length}/${expected.length} files`;
  });
  return `check-test-run: ${counts.join(", ")} ran`;
}

async function main(args) {
  const { expect, command } = parseArguments(args);
  const expectFile = resolve(expect);
  const { projects } = JSON.parse(readFileSync(expectFile, "utf8"));
  const root = dirname(expectFile);
  const scratch = mkdtempSync(join(tmpdir(), "check-test-run-"));
  try {
    const reportFile = join(scratch, "report.json");
    const code = await run(command, reportFile);
    const report = readReport(reportFile);
    const problems = testRunProblems({ report, projects, root });
    if (problems.length > 0) {
      console.error(
        `\ncheck-test-run: FAILED (agbossjs/agboss#630) — the run did not run every test it declares:`,
      );
      for (const problem of problems) console.error(`  ✗ ${problem}`);
      return code === 0 ? 1 : code;
    }
    if (code === 0) console.log(summaryOf(projects, root, report));
    return code;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof UsageError ? `${error.message}\n${USAGE}` : error);
      process.exit(error instanceof UsageError ? 2 : 1);
    },
  );
}
