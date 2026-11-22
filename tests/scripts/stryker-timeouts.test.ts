/**
 * agbossjs/mongodb#103 (agbossjs/agboss#1367): a Stryker Timeout is a hang, and an error is not a pass. `scripts/stryker-timeouts.mjs` fails a shard's
 * JSON report that holds a Timeout, a RuntimeError or a CompileError nobody justified (a survivor reads as a
 * Timeout when its run outlasts Stryker's limit, agbossjs/mongodb#103; Stryker leaves the errors out of its
 * score), and an entry of the proven list that matches none of its shard's mutants; `stryker.config.mjs`
 * gives every shard its own `timeoutMS` and a `timeoutFactor`, and every mutation vitest config its own
 * `testTimeout` and `hookTimeout`, none a `testNamePattern`.
 */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runProcess } from "../support/process.js";

const repo = new URL("../../", import.meta.url).pathname;
const script = join(repo, "scripts/stryker-timeouts.mjs");

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "stryker-timeouts-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Mutant {
  readonly id: string;
  readonly mutatorName: string;
  readonly status: string;
  readonly statusReason?: string;
  readonly replacement: string;
  readonly location: { readonly start: { readonly line: number; readonly column: number } };
}

const mutant = (
  id: string,
  mutatorName: string,
  line: number,
  status: string,
  statusReason?: string,
): Mutant => ({
  id,
  mutatorName,
  status,
  ...(statusReason === undefined ? {} : { statusReason }),
  replacement: "{}",
  location: { start: { line, column: 1 } },
});

/** A file of a report: its source (the lines the mutants are on) and its mutants. */
interface FileReport {
  source: string;
  mutants: Mutant[];
}
const LOOP = "for (;;) {\n  retry();\n  if (stopped()) return;\n}\n";

/** The script on the report `<shard>.json` holding `files` and a proven list; its exit code and what it said. */
async function checked(
  files: Record<string, FileReport>,
  hangs: readonly Record<string, unknown>[],
  shard = "leases",
  flags: readonly string[] = [],
): Promise<{ code: number | null; said: string }> {
  const report = join(dir, `${shard}.json`);
  const list = join(dir, "hangs.json");
  fs.writeFileSync(
    report,
    JSON.stringify({
      schemaVersion: "2",
      files: Object.fromEntries(
        Object.entries(files).map(([name, file]) => [name, { language: "typescript", ...file }]),
      ),
    }),
  );
  fs.writeFileSync(list, JSON.stringify(hangs));
  const run = await runProcess("node", [script, ...flags, "--hangs", list, report]);
  return { code: run.status, said: run.stdout + run.stderr };
}

const HIT = "Hit limit reached (1000/100)";
const HANG = {
  shard: "leases",
  file: "src/loop.ts",
  mutator: "BlockStatement",
  replacement: "{}",
  anchor: "retry();",
  kind: "wall-clock",
  reason: "the retry loop's body is {}: the loop never ends",
};
/** The loop's mutant, as a Timeout the time limit ended, on the loop's second line. */
const hung = (line = 2, id = "3"): Record<string, FileReport> => ({
  "src/loop.ts": { source: LOOP, mutants: [mutant(id, "BlockStatement", line, "Timeout")] },
});

describe("scripts/stryker-timeouts.mjs", () => {
  it("passes a report with no Timeout or error, whatever else it holds", async () => {
    const run = await checked(
      {
        "src/a.ts": {
          source: "a\nb\n",
          mutants: [
            mutant("1", "StringLiteral", 1, "Killed"),
            mutant("2", "StringLiteral", 2, "Survived"),
          ],
        },
      },
      [],
    );

    expect(run.said).toContain("no Timeout or error of");
    expect(run.code).toBe(0);
  });

  it("fails a Timeout nobody proved, naming the file, line, mutator, kind and what to do", async () => {
    const run = await checked(hung(2, "7"), []);

    expect(run.code).toBe(1);
    expect(run.said).toMatch(
      /src\/loop\.ts:2: Timeout \(wall-clock\) of a BlockStatement mutant -> \{\}; line: retry\(\);/,
    );
    expect(run.said).toContain("run it alone with a limit of 3 x the shard's run");
  });

  it("counts a Timeout of Stryker's hit limit and lists none: a loop ended by its count races a test that fails first", async () => {
    const files = {
      "src/loop.ts": { source: LOOP, mutants: [mutant("3", "BlockStatement", 2, "Timeout", HIT)] },
    };

    const run = await checked(files, []);
    const listed = await checked(files, [{ ...HANG, kind: "hit-limit" }]);

    expect(run.code).toBe(0);
    expect(run.said).toContain(
      "1 Timeouts of Stryker's hit limit (loops that do not end), not listed",
    );
    expect(listed.code).toBe(1);
    expect(listed.said).toContain(
      'kind "hit-limit" is none of wall-clock, runtime-error, compile-error',
    );
  });

  it("passes a Timeout on the list, wherever its line and id are now", async () => {
    const run = await checked(
      {
        "src/loop.ts": {
          source: `// moved down\n// by an edit\n${LOOP}`,
          mutants: [mutant("912", "BlockStatement", 4, "Timeout")],
        },
      },
      [HANG],
    );

    expect(run.code).toBe(0);
    expect(run.said).toContain("1 listed");
  });

  it.each([
    ["another shard", { ...HANG, shard: "other" }],
    ["another file", { ...HANG, file: "src/other.ts" }],
    ["another mutator", { ...HANG, mutator: "StringLiteral" }],
    ["another replacement", { ...HANG, replacement: "false" }],
    ["another anchor", { ...HANG, anchor: "somethingElse();" }],
    ["another kind", { ...HANG, kind: "runtime-error" }],
  ])("fails a Timeout whose %s is the one listed", async (_name, entry) => {
    const run = await checked({ ...hung(), "src/other.ts": { source: "x\n", mutants: [] } }, [
      entry,
    ]);

    expect(run.code).toBe(1);
    expect(run.said).toContain("Timeout (wall-clock)");
  });

  it("fails an entry that matches no mutant of its shard, or a Survived one: stale; tells of a Killed one", async () => {
    const at = (status: string): Record<string, FileReport> => ({
      "src/loop.ts": { source: LOOP, mutants: [mutant("3", "BlockStatement", 2, status)] },
    });

    const gone = await checked({ "src/loop.ts": { source: LOOP, mutants: [] } }, [HANG]);
    const survived = await checked(at("Survived"), [HANG]);
    const killed = await checked(at("Killed"), [HANG]);
    const other = await checked(at("Killed"), [{ ...HANG, shard: "other" }]);
    const partial = await checked(at("Survived"), [HANG], "leases", ["--partial"]);

    expect(gone.code).toBe(1);
    expect(gone.said).toMatch(
      /PROVEN_HANGS has src\/loop\.ts BlockStatement -> \{\} \(wall-clock, "retry\(\);"\) that matches no mutant.*stale/,
    );
    expect(survived.code).toBe(1);
    expect(survived.said).toContain("matches a Survived mutant");
    expect(killed.code).toBe(0);
    expect(killed.said).toMatch(
      /note: src\/loop\.ts "retry\(\);" \(wall-clock\) was Killed in this run/,
    );
    expect(other.code).toBe(0);
    expect(partial.code).toBe(0);
  });

  it.each([
    ["RuntimeError", "runtime-error"],
    ["CompileError", "compile-error"],
  ])("fails a %s nobody justified, and passes it once listed", async (status, kind) => {
    const files = {
      "src/loop.ts": { source: LOOP, mutants: [mutant("3", "BlockStatement", 2, status)] },
    };

    const unlisted = await checked(files, []);
    const listed = await checked(files, [{ ...HANG, kind, reason: "the index it makes clashes" }]);

    expect(unlisted.code).toBe(1);
    expect(unlisted.said).toContain(`${status} (${kind})`);
    expect(listed.code).toBe(0);
  });

  it.each([
    ["no reason", { ...HANG, reason: " " }, /needs reason/],
    ["no anchor", { ...HANG, anchor: undefined }, /needs anchor/],
    ["no shard", { ...HANG, shard: "" }, /needs shard/],
    ["an unknown kind", { ...HANG, kind: "slow" }, /kind "slow" is none of/],
  ])("fails a list entry with %s", async (_name, entry, said) => {
    const run = await checked({ "src/a.ts": { source: "", mutants: [] } }, [entry]);

    expect(run.code).toBe(1);
    expect(run.said).toMatch(said);
  });

  it("fails an entry listed twice", async () => {
    const run = await checked(hung(), [HANG, HANG]);

    expect(run.code).toBe(1);
    expect(run.said).toContain("is listed twice");
  });

  it("the proven list of the repo is well formed: every entry has its fields and reason, none twice", async () => {
    const report = join(dir, "no-such-shard.json");
    fs.writeFileSync(report, JSON.stringify({ files: {} }));

    const run = await runProcess("node", [script, report]);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("fails a file that is no Stryker report", async () => {
    const report = join(dir, "other.json");
    fs.writeFileSync(report, "{}");

    const run = await runProcess("node", [script, report]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("not a Stryker JSON report");
  });

  it("reports every unjustified mutant in one run, across reports", async () => {
    const body = (line: number): string =>
      JSON.stringify({
        files: {
          "src/a.ts": {
            source: "a\nb\n",
            mutants: [mutant("1", "StringLiteral", line, "Timeout")],
          },
        },
      });
    fs.writeFileSync(join(dir, "one.json"), body(1));
    fs.writeFileSync(join(dir, "two.json"), body(2));

    const run = await runProcess("node", [script, join(dir, "one.json"), join(dir, "two.json")]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("one.json: src/a.ts:1");
    expect(run.stderr).toContain("two.json: src/a.ts:2");
  });
});

describe("agbossjs/mongodb#103: the mutation configs", () => {
  async function configured(): Promise<{
    shards: string[];
    timeouts: Record<string, number>;
    factor: number;
    timeoutMS: number;
  }> {
    const run = await runProcess(
      "node",
      [
        "--input-type=module",
        "-e",
        "const { SHARDS } = await import(process.argv[1]);" +
          "const { TIMEOUTS_MS } = await import(process.argv[2]);" +
          "const config = (await import(process.argv[3])).default;" +
          "console.log(JSON.stringify({ shards: Object.keys(SHARDS), timeouts: TIMEOUTS_MS, factor: config.timeoutFactor, timeoutMS: config.timeoutMS }));",
        join(repo, "scripts/mutation-shards.mjs"),
        join(repo, "scripts/stryker-timeouts-ms.mjs"),
        join(repo, "stryker.config.mjs"),
      ],
      { cwd: repo, env: { ...process.env, MUTATION_SHARD: "migrations" } },
    );
    expect(run.status).toBe(0);
    return JSON.parse(run.stdout) as {
      shards: string[];
      timeouts: Record<string, number>;
      factor: number;
      timeoutMS: number;
    };
  }

  it("every shard has a timeoutMS of 120 s or more, the config uses its own, a timeoutFactor is set", async () => {
    const { shards, timeouts, factor, timeoutMS } = await configured();

    expect(Object.keys(timeouts).sort()).toEqual([...shards].sort());
    for (const [shard, ms] of Object.entries(timeouts))
      expect(ms, shard).toBeGreaterThanOrEqual(120_000);
    expect(timeoutMS).toBe(timeouts.migrations);
    expect(factor).toBeGreaterThanOrEqual(3);
  });

  it("every entry of the proven list names a shard of the config", async () => {
    const list = JSON.parse(
      fs.readFileSync(join(repo, "scripts/stryker-proven-hangs.json"), "utf8"),
    ) as { shard: string }[];
    const { shards } = await configured();

    for (const { shard } of list) expect(shards, shard).toContain(shard);
  });

  it("the vitest mutation config sets testTimeout and hookTimeout, and no testNamePattern", () => {
    const text = fs.readFileSync(join(repo, "vitest.mutation.config.ts"), "utf8");

    expect(text).toMatch(/^\s*testTimeout: [\d_]+,$/m);
    expect(text).toMatch(/^\s*hookTimeout: [\d_]+,$/m);
    // vitest keeps a config's pattern as an override of Stryker's per-mutant one: every mutant ran every test
    expect(text).not.toMatch(/^\s*testNamePattern:/m);
  });

  it("both workflows run the check on every shard's report, and the cold cache is keyed by the limits", () => {
    for (const name of ["ci.yml", "mutation-nightly.yml"]) {
      const text = fs.readFileSync(join(repo, ".github/workflows", name), "utf8");

      expect(text, name).toContain(
        "node scripts/stryker-timeouts.mjs reports/mutation/${{ matrix.shard }}.json",
      );
    }
    const ci = fs.readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("scripts/stryker-timeouts-ms.mjs");
  });
});
