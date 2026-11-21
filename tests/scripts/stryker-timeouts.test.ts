/**
 * agbossjs/mongodb#103 (agbossjs/agboss#1367): `scripts/stryker-timeouts.mjs` fails a shard whose
 * report has a Timeout that is not a proven hang, and a proven hang no Timeout matches; every mutation
 * job runs it, and the shards' `timeoutMS` is above the longest whole run.
 */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SHARDS } from "../../scripts/mutation-shards.mjs";
import { PROVEN_HANGS, staleHangs, unprovenTimeouts } from "../../scripts/stryker-timeouts.mjs";
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

const mutant = (status: string, line: number, mutatorName = "ConditionalExpression") => ({
  id: String(line),
  mutatorName,
  replacement: "true",
  status,
  location: { start: { line, column: 1 }, end: { line, column: 2 } },
});

const reportOf = (...mutants: ReturnType<typeof mutant>[]) => ({
  files: { "src/stores/a.ts": { mutants } },
});

async function run(report: unknown, shard = "leases") {
  const path = join(dir, "report.json");
  fs.writeFileSync(path, JSON.stringify(report));
  const result = await runProcess("node", [script, path], {
    env: { ...process.env, MUTATION_SHARD: shard },
  });
  return { code: result.status, said: result.stdout + result.stderr };
}

describe("scripts/stryker-timeouts.mjs", () => {
  it("a report with no Timeout passes, whatever else it holds", async () => {
    const result = await run(reportOf(mutant("Killed", 3), mutant("Survived", 4)));

    expect(result.code).toBe(0);
    expect(result.said).toContain("every one is a proven hang");
  });

  it("a Timeout that is not proven fails, naming file, line and mutator", async () => {
    const result = await run(reportOf(mutant("Killed", 3), mutant("Timeout", 9, "BlockStatement")));

    expect(result.code).toBe(1);
    expect(result.said).toContain("src/stores/a.ts:9 BlockStatement -> true");
    expect(result.said).not.toContain("a.ts:3");
  });
});

describe("unprovenTimeouts and staleHangs", () => {
  const proven = {
    leases: [{ file: "stores/a.ts", line: 9, mutator: "BlockStatement", reason: "loops" }],
  };

  it("a Timeout the shard names is proven; the same line in another shard is not", () => {
    const report = reportOf(mutant("Timeout", 9, "BlockStatement"));

    expect(unprovenTimeouts(report, "leases", proven)).toEqual([]);
    expect(unprovenTimeouts(report, "money", proven)).toHaveLength(1);
  });

  it("another line, or another mutator, of a proven file is not proven", () => {
    expect(
      unprovenTimeouts(reportOf(mutant("Timeout", 10, "BlockStatement")), "leases", proven),
    ).toHaveLength(1);
    expect(unprovenTimeouts(reportOf(mutant("Timeout", 9)), "leases", proven)).toHaveLength(1);
  });

  it("a proven hang that is Killed or absent in the report is stale", () => {
    expect(
      staleHangs(reportOf(mutant("Killed", 9, "BlockStatement")), "leases", proven),
    ).toHaveLength(1);
    expect(staleHangs(reportOf(mutant("Timeout", 9, "BlockStatement")), "leases", proven)).toEqual(
      [],
    );
  });

  it("every proven hang of the repository has a reason and names a shard that exists", () => {
    expect(Object.keys(PROVEN_HANGS).every((shard) => shard in SHARDS)).toBe(true);
    for (const [shard, hangs] of Object.entries(PROVEN_HANGS)) {
      expect(Object.keys(SHARDS)).toContain(shard);
      for (const hang of hangs) expect(hang.reason.length).toBeGreaterThan(20);
    }
  });
});

describe("the mutation jobs", () => {
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

  it("the config's timeoutMS is above the longest whole run measured (3 min 10 s of leases in CI)", () => {
    const config = fs.readFileSync(join(repo, "stryker.config.mjs"), "utf8");
    const bound = Number(/DEFAULT_TIMEOUT_MS = ([\d_]+)/u.exec(config)?.[1]?.replaceAll("_", ""));

    expect(bound).toBeGreaterThanOrEqual(2 * 190_000);
    expect(config).toContain("timeoutMS: shard.timeoutMS ?? DEFAULT_TIMEOUT_MS");
  });
});
