/**
 * agbossjs/mongodb#103 (agbossjs/agboss#1367): `scripts/stryker-timeouts.mjs` fails a shard whose
 * report has a Timeout that is not a proven hang, a proven hang no Timeout matches, or a mutant that
 * ended in an error; every mutation job runs it; the shards' bound is above a mutant's whole run.
 */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SHARDS } from "../../scripts/mutation-shards.mjs";
import {
  erroredMutants,
  PROVEN_HANGS,
  staleHangs,
  unprovenTimeouts,
  type ProvenHang,
  type StrykerReport,
} from "../../scripts/stryker-timeouts.mjs";
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

const SOURCE = ["export function loop() {", "  for (;;) {", "    step();", "  }", "}"].join("\n");

const mutant = (
  status: string,
  line: number,
  extra: { mutatorName?: string; replacement?: string; statusReason?: string } = {},
) => ({
  mutatorName: "BlockStatement",
  replacement: "{}",
  status,
  location: { start: { line } },
  ...extra,
});

const reportOf = (...mutants: ReturnType<typeof mutant>[]): StrykerReport => ({
  files: { "src/stores/a.ts": { source: SOURCE, mutants } },
});

const HANG: ProvenHang = {
  file: "stores/a.ts",
  mutator: "BlockStatement",
  replacement: "{}",
  anchor: "for (;;) {",
  kind: "wall-clock",
  reason: "the loop's body is emptied: it spins on the microtask queue and no timer ends it",
};
const proven = { leases: [HANG] };

async function run(report: unknown, ...flags: string[]) {
  const path = join(dir, "report.json");
  fs.writeFileSync(path, JSON.stringify(report));
  const result = await runProcess("node", [script, ...flags, path], {
    env: { ...process.env, MUTATION_SHARD: "leases" },
  });
  return { code: result.status, said: result.stdout + result.stderr };
}

describe("scripts/stryker-timeouts.mjs", () => {
  it("a report with no Timeout and no error passes, whatever else it holds", async () => {
    const result = await run(reportOf(mutant("Killed", 3), mutant("Survived", 4)));

    expect(result.code).toBe(0);
    expect(result.said).toContain("every one is a proven hang");
  });

  it("a Timeout that is not proven fails, naming file, line, mutator, replacement, kind and the line's text", async () => {
    const result = await run(reportOf(mutant("Killed", 3), mutant("Timeout", 2)));

    expect(result.code).toBe(1);
    expect(result.said).toContain(
      'src/stores/a.ts:2 BlockStatement -> {} [wall-clock] "for (;;) {"',
    );
    expect(result.said).not.toContain("a.ts:3");
  });

  it("a RuntimeError or a CompileError fails, with its reason: Stryker leaves them out of the score", async () => {
    const result = await run(
      reportOf(
        mutant("RuntimeError", 3, { statusReason: "ERR_WORKER_OUT_OF_MEMORY" }),
        mutant("CompileError", 4),
      ),
    );

    expect(result.code).toBe(1);
    expect(result.said).toContain("ERR_WORKER_OUT_OF_MEMORY");
    expect(result.said).toContain("a.ts:4");
  });
});

describe("unprovenTimeouts", () => {
  const timeout = (extra = {}) => reportOf(mutant("Timeout", 2, extra));

  it("a Timeout the shard names, by file, mutator, replacement, line text and kind, is proven", () => {
    expect(unprovenTimeouts(timeout(), "leases", proven)).toEqual([]);
  });

  it.each([
    ["another shard", "money", {}],
    ["another mutator", "leases", { mutatorName: "ConditionalExpression" }],
    ["another replacement", "leases", { replacement: "true" }],
    [
      "a hit limit where a wall clock was proved",
      "leases",
      { statusReason: "Hit limit reached (5/4)" },
    ],
  ])("%s is not proven", (_name, shard, extra) => {
    expect(unprovenTimeouts(timeout(extra), shard, proven)).toHaveLength(1);
  });

  it("the same mutant on another line of text is not proven", () => {
    const moved = {
      files: {
        "src/stores/a.ts": { source: `// moved\n${SOURCE}`, mutants: [mutant("Timeout", 2)] },
      },
    };

    expect(unprovenTimeouts(moved, "leases", proven)).toHaveLength(1);
  });

  it("the line's text, not its number, is what a hang is told by", () => {
    const moved = {
      files: {
        "src/stores/a.ts": { source: `// moved\n${SOURCE}`, mutants: [mutant("Timeout", 3)] },
      },
    };

    expect(unprovenTimeouts(moved, "leases", proven)).toEqual([]);
  });
});

describe("staleHangs and erroredMutants", () => {
  it("a proven hang that is Killed or absent in the report is stale", () => {
    expect(staleHangs(reportOf(mutant("Killed", 2)), "leases", proven)).toEqual([HANG]);
    expect(staleHangs(reportOf(mutant("Timeout", 2)), "leases", proven)).toEqual([]);
  });

  it("a hang of kind `any` matches a Timeout of either kind, and is never stale (a loop ends as Killed or as Timeout, by the run)", () => {
    const either = { ...proven, leases: [{ ...HANG, kind: "any" as const }] };

    expect(unprovenTimeouts(reportOf(mutant("Timeout", 2)), "leases", either)).toEqual([]);
    expect(
      unprovenTimeouts(
        reportOf(mutant("Timeout", 2, { statusReason: "Hit limit reached (5/4)" })),
        "leases",
        either,
      ),
    ).toEqual([]);
    expect(staleHangs(reportOf(mutant("Killed", 2)), "leases", either)).toEqual([]);
  });

  it("the errored ones are the RuntimeErrors and the CompileErrors", () => {
    expect(erroredMutants(reportOf(mutant("Killed", 2), mutant("RuntimeError", 3)))).toHaveLength(
      1,
    );
  });

  it("every proven hang of the repository has a reason, a kind and a shard that exists", () => {
    expect(Object.keys(PROVEN_HANGS).every((shard) => shard in SHARDS)).toBe(true);
    for (const hangs of Object.values(PROVEN_HANGS))
      for (const hang of hangs) {
        expect(hang.reason.length).toBeGreaterThan(20);
        expect(["hit-limit", "wall-clock", "any"]).toContain(hang.kind);
        expect(hang.anchor.length).toBeGreaterThan(0);
      }
  });
});

describe("the mutation jobs and the config", () => {
  it.each([".github/workflows/ci.yml", ".github/workflows/mutation-nightly.yml"])(
    "%s runs the script after the shard, also when the shard failed",
    (file) => {
      const workflow = fs.readFileSync(join(repo, file), "utf8");

      expect(workflow).toContain("node scripts/stryker-timeouts.mjs");
      expect(workflow).toMatch(
        /if: always\(\) && hashFiles\(format\('reports\/mutation\/\{0\}\.json'/u,
      );
    },
  );

  it("the factor is 3 (the dry run is made alone, the mutants three at a time) and a shard may set its own bound", () => {
    const config = fs.readFileSync(join(repo, "stryker.config.mjs"), "utf8");

    expect(config).toContain("timeoutFactor: 3");
    expect(config).toContain("timeoutMS: shard.timeoutMS ?? DEFAULT_TIMEOUT_MS");
  });

  it("no shard filters by test name: Vitest 3 would apply it over Stryker's own filter on every mutant", () => {
    const config = fs.readFileSync(join(repo, "vitest.mutation.config.ts"), "utf8");

    expect(config).not.toContain("testNamePattern");
    for (const shard of Object.values(SHARDS)) expect(shard).not.toHaveProperty("testNamePattern");
  });
});
