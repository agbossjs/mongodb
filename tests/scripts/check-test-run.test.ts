/**
 * agbossjs/agboss#630 — `scripts/check-test-run.mjs` (the core's, copied): a gate run never passes without the tests it is meant to
 * run. It runs vitest with its JSON report, then holds the report against the projects a file
 * declares (`test-run.json`, `test-run.faults.json`): every file of every project ran a test, each project at least its
 * `minFiles`. Its pure parts here, then the whole command on a scratch project of two vitest
 * projects — whole, and with one project left out of its vitest config.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repo = new URL("../../", import.meta.url).pathname;
const script = join(repo, "scripts/check-test-run.mjs");
const vitest = join(repo, "node_modules/vitest/vitest.mjs");

interface ExpectedProject {
  readonly name: string;
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
  readonly minFiles: number;
}
interface ReportFile {
  readonly name: string;
  readonly assertionResults: readonly { readonly status: string }[];
}
interface CheckTestRun {
  readonly testRunProblems: (input: {
    readonly report: { readonly testResults: readonly ReportFile[] } | undefined;
    readonly projects: readonly ExpectedProject[];
    readonly root: string;
  }) => string[];
  readonly expectedFilesOf: (project: ExpectedProject, root: string) => string[];
}
const { testRunProblems, expectedFilesOf } = (await import(script)) as CheckTestRun;

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** `node <args…>`, awaited: a test never holds its vitest fork with a synchronous child. */
const runNode = (
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<Ran> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: options.cwd, env: options.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });

const scratch = mkdtempSync(join(tmpdir(), "agboss-check-test-run-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A folder of empty files at `paths` (relative), for the globs. */
function tree(name: string, paths: readonly string[]): string {
  const root = join(scratch, name);
  for (const path of paths) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), "");
  }
  return root;
}

const UNIT: ExpectedProject = {
  name: "unit",
  include: ["tests/**/*.test.ts"],
  exclude: ["tests/faults/**"],
  minFiles: 2,
};
const FAULTS: ExpectedProject = {
  name: "faults",
  include: ["tests/faults/*.test.ts"],
  minFiles: 2,
};
const A = "tests/a.test.ts";
const B = "tests/b/b.test.ts";
const F1 = "tests/faults/f1.test.ts";
const F2 = "tests/faults/f2.test.ts";
const FILES = [A, B, F1, F2];

const ran = (root: string, path: string, statuses = ["passed"]): ReportFile => ({
  name: join(root, path),
  assertionResults: statuses.map((status) => ({ status })),
});

describe("agbossjs/agboss#630: the report against the declared projects", () => {
  it("each project's files are its include minus its exclude, sorted, relative to the root", () => {
    const root = tree("globs", FILES);

    expect(expectedFilesOf(UNIT, root)).toEqual(["tests/a.test.ts", "tests/b/b.test.ts"]);
    expect(expectedFilesOf(FAULTS, root)).toEqual([
      "tests/faults/f1.test.ts",
      "tests/faults/f2.test.ts",
    ]);
  });

  it("every file of every project ran a test: no problem", () => {
    const root = tree("whole", FILES);
    const report = { testResults: FILES.map((path) => ran(root, path, ["passed", "skipped"])) };

    expect(testRunProblems({ report, projects: [UNIT, FAULTS], root })).toEqual([]);
  });

  it("a project none of whose files ran — run 41261656814 — is named, with its count and files", () => {
    const root = tree("dropped", FILES);
    const report = { testResults: [ran(root, A), ran(root, B)] };

    expect(testRunProblems({ report, projects: [UNIT, FAULTS], root })).toEqual([
      "faults: 0 of its 2 test files ran — not run: tests/faults/f1.test.ts, tests/faults/f2.test.ts",
    ]);
  });

  it("one file missing from a project is named", () => {
    const root = tree("one-missing", FILES);
    const report = {
      testResults: [ran(root, A), ran(root, F1), ran(root, F2)],
    };

    expect(testRunProblems({ report, projects: [UNIT, FAULTS], root })).toEqual([
      "unit: 1 of its 2 test files ran — not run: tests/b/b.test.ts",
    ]);
  });

  it("a file whose every test was skipped, or that collected none, did not run", () => {
    const root = tree("skipped", FILES);
    const report = {
      testResults: [
        ran(root, A),
        ran(root, B, ["skipped", "todo"]),
        ran(root, F1, []),
        ran(root, F2, ["failed"]),
      ],
    };

    expect(testRunProblems({ report, projects: [UNIT, FAULTS], root })).toEqual([
      "unit: 1 of its 2 test files ran — not run: tests/b/b.test.ts",
      "faults: 1 of its 2 test files ran — not run: tests/faults/f1.test.ts",
    ]);
  });

  it("fewer files on disk than a project's minFiles — a moved folder, a glob that drifted — fails", () => {
    const root = tree("moved", ["tests/a.test.ts", "tests/b/b.test.ts", "tests/fault/f1.test.ts"]);
    const report = { testResults: [ran(root, "tests/a.test.ts"), ran(root, "tests/b/b.test.ts")] };

    expect(testRunProblems({ report, projects: [UNIT, FAULTS], root })).toEqual([
      "unit: 2 of its 3 test files ran — not run: tests/fault/f1.test.ts",
      "faults: 0 files match tests/faults/*.test.ts, fewer than its minFiles 2",
    ]);
  });

  it("no report — the run ended before writing it — fails", () => {
    expect(testRunProblems({ report: undefined, projects: [UNIT], root: scratch })).toEqual([
      "no vitest JSON report: the run ended before it was written",
    ]);
  });
});

/** A project of two vitest projects (`unit`, `faults` in a single fork) and its `test-run.json`. */
function scratchProject(name: string, vitestProjects: readonly string[]): string {
  const root = join(scratch, name);
  mkdirSync(join(root, "tests/faults"), { recursive: true });
  const projects = {
    unit: `{ test: { name: "unit", globals: true, include: ["tests/*.test.mjs"] } }`,
    faults: `{ test: { name: "faults", globals: true, include: ["tests/faults/*.test.mjs"], pool: "forks", poolOptions: { forks: { singleFork: true } } } }`,
  } as const;
  const listed = vitestProjects.map((project) => projects[project as keyof typeof projects]);
  writeFileSync(
    join(root, "vitest.config.mjs"),
    `export default { test: { projects: [${listed.join(", ")}] } };\n`,
  );
  writeFileSync(join(root, "tests/a.test.mjs"), 'it("a", () => { expect(1).toBe(1); });\n');
  writeFileSync(join(root, "tests/faults/f.test.mjs"), 'it("f", () => { expect(1).toBe(1); });\n');
  const expected = {
    projects: [
      { name: "unit", include: ["tests/*.test.mjs"], minFiles: 1 },
      { name: "faults", include: ["tests/faults/*.test.mjs"], minFiles: 1 },
    ],
  };
  writeFileSync(join(root, "test-run.json"), JSON.stringify(expected));
  return root;
}

const checkTestRun = (root: string, ...command: string[]) =>
  runNode([script, "--expect", "test-run.json", "--", ...command], {
    cwd: root,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST"))),
      NO_COLOR: "1",
    },
  });

describe("agbossjs/agboss#630: the command", () => {
  it("both projects ran: exit 0, each project's count printed", async () => {
    const root = scratchProject("both", ["unit", "faults"]);

    const run = await checkTestRun(root, process.execPath, vitest, "run");

    expect(run.stderr).not.toContain("FAILED");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("check-test-run: unit 1/1 files, faults 1/1 files ran");
  }, 60_000);

  it("the faults project left out of the vitest config: vitest passes, the check fails by name", async () => {
    const root = scratchProject("no-faults", ["unit"]);

    const run = await checkTestRun(root, process.execPath, vitest, "run");

    expect(run.stdout).toContain("1 passed");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("check-test-run: FAILED (agbossjs/agboss#630)");
    expect(run.stderr).toContain(
      "faults: 0 of its 1 test files ran — not run: tests/faults/f.test.mjs",
    );
  }, 60_000);

  it("a failing vitest keeps its own exit code, and the check still names what did not run", async () => {
    const root = scratchProject("failing", ["unit"]);
    writeFileSync(join(root, "tests/a.test.mjs"), 'it("a", () => { expect(1).toBe(2); });\n');

    const run = await checkTestRun(root, process.execPath, vitest, "run");

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("faults: 0 of its 1 test files ran");
  }, 60_000);

  it("no command, or no --expect: a usage error, exit 2", async () => {
    const root = scratchProject("usage", ["unit"]);

    expect((await runNode([script, "--expect", "test-run.json"], { cwd: root })).status).toBe(2);
    expect((await runNode([script, "--", "true"], { cwd: root })).status).toBe(2);
  });
});
