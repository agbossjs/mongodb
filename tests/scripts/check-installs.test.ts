/**
 * agbossjs/agboss#523 AC1 — `scripts/check-installs.mjs` (`npm run check:installs`, in `npm run check`): no workflow
 * installs by resolving ranges or runs an unpinned `npx`, no script passes `install` to npm but
 * through `rangeInstallArguments()`; and this repository has none of either.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runNode } from "../support/process.js";

const repo = new URL("../../", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "agboss-check-installs-"));

interface CheckInstalls {
  readonly workflowProblems: (text: string, file: string) => readonly string[];
  readonly scriptProblems: (text: string, file: string) => readonly string[];
}
const { workflowProblems, scriptProblems } = (await import(
  join(repo, "scripts/check-installs.mjs")
)) as CheckInstalls;

const step = (command: string): string => `      - run: ${command}\n`;
const inWorkflow = (command: string): readonly string[] =>
  workflowProblems(step(command), "ci.yml");

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("AC1: a workflow installs from its lockfile", () => {
  it.each(["npm ci", "npm ci --no-audit --no-fund", "npm --prefix .agboss-source ci"])(
    "AC1: %s passes",
    (command) => {
      expect(inWorkflow(command)).toEqual([]);
    },
  );

  it.each(["npm run install:packed", "npm run build", "npm test", "cache: npm"])(
    "AC1: %s is not an install",
    (command) => {
      expect(inWorkflow(command)).toEqual([]);
    },
  );

  it.each([
    ["npm install", "install"],
    ["npm i", "i"],
    ["npm install --no-audit left-pad", "install"],
    ["npm --prefix .agboss-source install", "install"],
    ["npm add zod", "add"],
    ["npm update", "update"],
    ["cd x && npm install", "install"],
  ])("AC1: %s fails, naming the line", (command, sub) => {
    expect(inWorkflow(command)).toEqual([
      `ci.yml:1: npm ${sub} resolves ranges: use npm ci (or --before, the minimum release age)`,
    ]);
  });

  it("AC1: an install with a minimum release age passes", () => {
    expect(inWorkflow("npm install --before=2026-10-28T00:00:00Z")).toEqual([]);
  });

  it("AC1: a comment naming npm install is no install", () => {
    expect(inWorkflow("npm ci # not npm install")).toEqual([]);
  });
});

describe("AC1: a workflow's npx runs a package pinned to an exact version", () => {
  it.each([
    "npx tsx@4.20.3 a.ts",
    "npx --yes @scope/tool@1.2.3-rc.1",
    "npm exec --package=a@1.0.0 -- a",
  ])("AC1: %s passes", (command) => {
    expect(inWorkflow(command)).toEqual([]);
  });

  it.each([
    ["npx tsx a.ts", "tsx"],
    ["npx --yes tsx@latest", "tsx@latest"],
    ["npx tsx@^4 a.ts", "tsx@^4"],
    ["npx @scope/tool@1.2", "@scope/tool@1.2"],
    ["npm exec --package=a@1 -- a", "a@1"],
    ["npm exec tsx", "tsx"],
  ])("AC1: %s fails", (command, spec) => {
    expect(inWorkflow(command)).toEqual([
      `ci.yml:1: ${spec} is not pinned to an exact version (name@x.y.z)`,
    ]);
  });
});

describe("AC1: a script's install arguments come from the minimum release age", () => {
  it("AC1: an install built by rangeInstallArguments() passes", () => {
    expect(scriptProblems('run("npm", rangeInstallArguments(["a.tgz"]));\n', "s.mjs")).toEqual([]);
  });

  it("AC1: npm's own install argument fails, and an npx run fails", () => {
    const text = 'run("npm", ["install", "a.tgz"]);\nrun("npx", ["vitest"]);\n';

    expect(scriptProblems(text, "s.mjs")).toEqual([
      "s.mjs:1: an npm install's arguments come from rangeInstallArguments()",
      "s.mjs:2: run a local tool from node_modules/.bin, not npx",
    ]);
  });
});

describe("AC1: the command", () => {
  const checkInstalls = (root: string) => runNode([join(repo, "scripts/check-installs.mjs"), root]);

  it("AC1: this repository's workflows and scripts pass, exit 0", async () => {
    const ran = await checkInstalls(repo);

    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
  });

  it("AC1: a planted unpinned install fails, exit 1, every problem listed", async () => {
    mkdirSync(join(scratch, ".github", "workflows"), { recursive: true });
    mkdirSync(join(scratch, "scripts"), { recursive: true });
    writeFileSync(
      join(scratch, ".github", "workflows", "ci.yml"),
      step("npm install") + step("npx tsx a.ts"),
    );
    writeFileSync(join(scratch, "scripts", "x.mjs"), 'spawn("npm", ["install"]);\n');

    const ran = await checkInstalls(scratch);

    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain(".github/workflows/ci.yml:1: npm install resolves ranges");
    expect(ran.stderr).toContain(".github/workflows/ci.yml:2: tsx is not pinned");
    expect(ran.stderr).toContain("scripts/x.mjs:1: an npm install's arguments");
    expect(ran.stderr).toContain("check:installs: 3 unreviewed install(s)");
  });
});

describe("AC1 acceptance: the forms a guard must not miss", () => {
  it.each([
    ["npm install-test", "install-test"],
    ["npm it", "it"],
    ["npm install --beforehand", "install"],
  ])("AC1: %s fails", (command, sub) => {
    expect(inWorkflow(command)).toEqual([
      `ci.yml:1: npm ${sub} resolves ranges: use npm ci (or --before, the minimum release age)`,
    ]);
  });

  it("AC1: an install continued on the next line with \\ fails, naming its first line", () => {
    const text = `${step("|")}        npm \\\n          install left-pad\n`;

    expect(workflowProblems(text, "ci.yml")).toEqual([
      "ci.yml:2: npm install resolves ranges: use npm ci (or --before, the minimum release age)",
    ]);
  });

  it("AC1: --before given before the subcommand passes; every --package= of an npx is checked", () => {
    expect(inWorkflow("npm --before=2026-10-28T00:00:00Z install")).toEqual([]);
    expect(inWorkflow("npx --package=tsx@4.20.3 --package=evil tsx")).toEqual([
      "ci.yml:1: evil is not pinned to an exact version (name@x.y.z)",
    ]);
  });

  it.each([
    ['execSync("npm install left-pad");', "an npm install's arguments"],
    ['spawnSync("npm", ["i", "left-pad"]);', "an npm install's arguments"],
    ['spawnSync("npm", ["add", "zod"]);', "an npm install's arguments"],
    ["execSync(`npx vitest run`);", "not npx"],
  ])("AC1: a script's %s fails", (line, why) => {
    const [problem] = scriptProblems(`${line}\n`, "s.mjs");

    expect(problem).toContain("s.mjs:1:");
    expect(problem).toContain(why);
  });

  it("AC1: a comment naming npx or npm install runs nothing; npm ci and npm run pass", () => {
    const text = [
      "// run `npx agboss check` or `npm install` by hand",
      " * `npx tsx` in a doc comment",
      'spawnSync("npm", ["ci", "--no-audit"]);',
      'spawnSync("npm", ["run", "install:packed"]);',
    ].join("\n");

    expect(scriptProblems(text, "s.mjs")).toEqual([]);
  });
});
