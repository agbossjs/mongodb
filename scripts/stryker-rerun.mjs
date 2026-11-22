// The rerun of a Timeout alone (agbossjs/mongodb#103), for scripts/stryker-timeouts.mjs; the stores copy both as they are.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** More unlisted Timeouts of the clock than this in one report are no flake of a loaded runner: none is rerun. */
export const MAX_RERUNS = 10;
/** The `timeoutMS` of a rerun: generous, for the one mutant alone. */
export const RERUN_TIMEOUT_MS = 600_000;

/** The status of the mutant of a rerun's report that is the one of `found` (same file, mutator, replacement and place). */
function statusOfRerun(report, found) {
  const there = report?.files?.[found.file]?.mutants ?? [];
  const same = there.find(
    (mutant) =>
      mutant.mutatorName === found.mutant.mutatorName &&
      String(mutant.replacement) === String(found.mutant.replacement) &&
      mutant.location.start.line === found.line &&
      mutant.location.start.column === found.mutant.location.start.column,
  );
  if (same === undefined) return undefined;
  return same.status === "Timeout" &&
    String(same.statusReason ?? "").startsWith("Hit limit reached")
    ? "Timeout (hit limit)"
    : same.status === "Timeout"
      ? "Timeout of the clock"
      : same.status;
}

/** Stryker's own bin, as the repo `cwd` is in installed it (hoisted or not), run by this Node. */
const strykerBinOf = (cwd) =>
  join(
    dirname(createRequire(join(cwd, "noop.js")).resolve("@stryker-mutator/core/package.json")),
    "bin",
    "stryker.js",
  );

/** The rerun's config, in `dir`: the repo's (`cwd`/stryker.config.mjs) with a report, incremental file and temp dir of its own. */
function writeRerunConfig(dir, cwd, shard, out) {
  const configFile = join(dir, "stryker.rerun.config.mjs");
  // Stryker has no flag for the json report's file: a config of its own wraps the repo's, which would write over the shard's
  writeFileSync(
    configFile,
    `import base from ${JSON.stringify(pathToFileURL(join(cwd, "stryker.config.mjs")).href)};\n` +
      `export default { ...base, reporters: ["json"], jsonReporter: { fileName: ${JSON.stringify(out)} }, ` +
      `incrementalFile: ${JSON.stringify(join(dir, "incremental.json"))}, tempDirName: ${JSON.stringify(`.stryker-tmp-${shard}-rerun`)} };\n`,
  );
  return configFile;
}

/**
 * The rerun of `found`, a mutant of `shard`, alone in a fresh Stryker process: `--concurrency 1 --force`, only the lines of
 * the mutant, a generous timeoutMS, and a config of its own (the repo's, with its own report, incremental file and temp dir).
 * @returns {{ status: string, detail: string }}
 */
export function rerunAlone(shard, found, { stryker, cwd, timeoutMs }) {
  const dir = mkdtempSync(join(tmpdir(), "stryker-rerun-"));
  const out = join(dir, "report.json");
  const last = found.mutant.location.end?.line ?? found.line;
  const configFile = writeRerunConfig(dir, cwd, shard, out);
  const args = [
    "run",
    "--concurrency",
    "1",
    "--force",
    "--mutate",
    `${found.file}:${String(found.line)}-${String(last)}`,
    "--timeoutMS",
    String(timeoutMs),
    configFile,
  ];
  try {
    const started = Date.now();
    const [command, ...lead] =
      stryker === undefined ? [process.execPath, strykerBinOf(cwd)] : [stryker];
    const run = spawnSync(command, [...lead, ...args], {
      cwd,
      env: { ...process.env, MUTATION_SHARD: process.env.MUTATION_SHARD ?? shard },
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 40 * 60_000,
    });
    const seconds = `${((Date.now() - started) / 1000).toFixed(1)} s`;
    let report;
    try {
      report = JSON.parse(readFileSync(out, "utf8"));
    } catch {
      return {
        status: "not run",
        detail: `Stryker left no report (exit ${String(run.status ?? run.signal)}, ${seconds})`,
      };
    }
    const status = statusOfRerun(report, found);
    return status === undefined
      ? { status: "not found", detail: `the rerun's report has no such mutant (${seconds})` }
      : { status, detail: seconds };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What the rerun of an unlisted Timeout of the clock makes of it: told and passed (`undefined`), or its problem. */
export function judgedAlone(name, shard, found, verdict, described) {
  const where = `${name}: note: ${found.file}:${String(found.line)} (${found.mutant.mutatorName} -> ${String(found.mutant.replacement)})`;
  if (verdict.status === "Killed") {
    console.log(
      `${where} ended as a Timeout in this run and was Killed run alone (${verdict.detail}): a slow runner, not a hang`,
    );
    return undefined;
  }
  if (verdict.status === "Timeout (hit limit)") {
    console.log(
      `${where} ended as a Timeout of the clock in this run and of Stryker's hit limit run alone (a loop that does not end), counted, not listed`,
    );
    return undefined;
  }
  return `${name}: ${described}. Run alone in a fresh Stryker process it was ${verdict.status} (${verdict.detail}): if it survived, kill it with a test; if it hangs for ever, add it to PROVEN_HANGS (shard ${shard}) with the reason; an error is a mutant no test judged: find out why`;
}
