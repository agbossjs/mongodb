#!/usr/bin/env node
// A Stryker Timeout counts as killed, and in this repository's shards it hid survivors
// (agbossjs/mongodb#103, agbossjs/agboss#1367): a mutant no test kills runs its covering tests to the
// end, which takes longer than Stryker's bound of 1.5 x their net time + `timeoutMS` unless that is
// above the shard's whole run — so every survivor read as a Timeout. Two rules now:
//   - `stryker.config.mjs` sets `timeoutMS` above a shard's whole run (`mutation-shards.mjs`), so a
//     hang is ended by vitest's own `testTimeout` / `hookTimeout` (a failing test: Killed, with `killedBy`)
//     and a Timeout is left for what no test can end: a synchronous loop;
//   - this script fails a shard whose report holds a Timeout that is not in `PROVEN_HANGS`, each with the
//     reason it is a real hang (the mutated code loops, or blocks the event loop, so no test ends it).
// A Timeout in the report that is neither is a survivor, or a mutant to kill, until proved otherwise:
// run it alone (`--mutate <file>:<lines> --concurrency 1`), and either kill it with a test or add it here.
// `node scripts/stryker-timeouts.mjs [report.json]` (default `reports/mutation/<MUTATION_SHARD>.json`).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The Timeouts that are real hangs, per shard: `file` (as the report names it, from `src/`), `line`,
 * `mutator`, and the `reason` — what the mutated code does that no test can end.
 */
export const PROVEN_HANGS = {};

/** The Timeouts of `report` (a Stryker JSON report) that `proven` does not name. */
export function unprovenTimeouts(report, shard, proven = PROVEN_HANGS) {
  const known = proven[shard] ?? [];
  const found = [];
  for (const [file, { mutants }] of Object.entries(report.files)) {
    for (const mutant of mutants) {
      if (mutant.status !== "Timeout") continue;
      const line = mutant.location.start.line;
      const isProven = known.some(
        (hang) =>
          file.endsWith(hang.file) && hang.line === line && hang.mutator === mutant.mutatorName,
      );
      if (!isProven)
        found.push(`${file}:${String(line)} ${mutant.mutatorName} -> ${mutant.replacement}`);
    }
  }
  return found;
}

/** The entries of `proven` that no Timeout of `report` matches: a stale reason. */
export function staleHangs(report, shard, proven = PROVEN_HANGS) {
  return (proven[shard] ?? []).filter(
    (hang) =>
      !Object.entries(report.files).some(
        ([file, { mutants }]) =>
          file.endsWith(hang.file) &&
          mutants.some(
            (mutant) =>
              mutant.status === "Timeout" &&
              mutant.location.start.line === hang.line &&
              mutant.mutatorName === hang.mutator,
          ),
      ),
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const shard = process.env.MUTATION_SHARD ?? "leases";
  const path = process.argv[2] ?? `reports/mutation/${shard}.json`;
  const report = JSON.parse(readFileSync(path, "utf8"));
  const unproven = unprovenTimeouts(report, shard);
  const stale = staleHangs(report, shard);
  if (unproven.length > 0)
    console.error(
      `Stryker Timeouts of shard ${shard} that are not proven hangs (a Timeout counts as killed, and hid survivors: agbossjs/mongodb#103) — kill each with a test, or prove it a hang in scripts/stryker-timeouts.mjs:\n  ${unproven.join("\n  ")}`,
    );
  if (stale.length > 0)
    console.error(
      `PROVEN_HANGS of shard ${shard} that no Timeout of the report matches (remove them):\n  ${stale
        .map((hang) => `${hang.file}:${String(hang.line)} ${hang.mutator}`)
        .join("\n  ")}`,
    );
  if (unproven.length > 0 || stale.length > 0) process.exit(1);
  console.log(`Stryker Timeouts of shard ${shard}: every one is a proven hang`);
}
