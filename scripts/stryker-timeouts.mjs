#!/usr/bin/env node
// A Stryker Timeout counts as killed, and in this repository's shards it hid survivors
// (agbossjs/mongodb#103, agbossjs/agboss#1367); a RuntimeError counts as nothing at all — Stryker
// leaves it out of the score. So a shard's report is held to three rules:
//   - a Timeout that is not in `PROVEN_HANGS` fails the shard: it is a survivor, or a mutant to kill,
//     until proved otherwise (run it alone: `--mutate <file>:<lines> --concurrency 1`);
//   - an entry of `PROVEN_HANGS` that no Timeout of the report matches fails it too (a stale reason),
//     in a whole-shard report (`--partial`, for a run of a few lines, skips this);
//   - any RuntimeError or CompileError fails it: an error outside a test run (a worker out of memory,
//     a conflict in a `beforeAll`) is a mutant nobody judged.
// A proven hang is told by what it is, never by a mutant's number or a bare line: `file`, `mutator`,
// `replacement` and `anchor` (the line's text, trimmed), and its `kind` — `hit-limit` (Stryker's own
// counter ended it: `statusReason` "Hit limit reached", seconds) or `wall-clock` (it ran out
// `timeoutMS` + `timeoutFactor` x the net time: a loop whose mutated test is outside the loop, a last
// resort that costs that long on every run). With each its `reason`: what the mutated code does that no
// test can end.
// `node scripts/stryker-timeouts.mjs [--partial] [report.json]` (default `reports/mutation/<MUTATION_SHARD>.json`).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROVEN_HANGS } from "./stryker-proven-hangs.mjs";

export { PROVEN_HANGS };

const kindOf = (mutant) =>
  typeof mutant.statusReason === "string" && mutant.statusReason.startsWith("Hit limit reached")
    ? "hit-limit"
    : "wall-clock";

/** The mutants of a report as `{ file, line, anchor, mutant }`. */
function* mutantsOf(report) {
  for (const [file, { mutants, source }] of Object.entries(report.files)) {
    const lines = typeof source === "string" ? source.split("\n") : [];
    for (const mutant of mutants) {
      const line = mutant.location.start.line;
      yield { file, line, anchor: (lines[line - 1] ?? "").trim(), mutant };
    }
  }
}

const matches = (hang, found) =>
  found.file.endsWith(hang.file) &&
  found.mutant.mutatorName === hang.mutator &&
  found.mutant.replacement === hang.replacement &&
  found.anchor === hang.anchor &&
  kindOf(found.mutant) === hang.kind;

const describe = (found) =>
  `${found.file}:${String(found.line)} ${found.mutant.mutatorName} -> ${found.mutant.replacement} [${kindOf(found.mutant)}] ${JSON.stringify(found.anchor)}`;

/** The Timeouts of `report` that `proven` does not name. */
export function unprovenTimeouts(report, shard, proven = PROVEN_HANGS) {
  const known = proven[shard] ?? [];
  return [...mutantsOf(report)]
    .filter((found) => found.mutant.status === "Timeout")
    .filter((found) => !known.some((hang) => matches(hang, found)))
    .map(describe);
}

/** The RuntimeErrors and CompileErrors of `report`: mutants no test judged. */
export function erroredMutants(report) {
  return [...mutantsOf(report)]
    .filter(
      (found) => found.mutant.status === "RuntimeError" || found.mutant.status === "CompileError",
    )
    .map((found) => `${describe(found)} — ${String(found.mutant.statusReason ?? "no reason")}`);
}

/** The entries of `proven` that no Timeout of `report` matches: a stale reason. */
export function staleHangs(report, shard, proven = PROVEN_HANGS) {
  const timeouts = [...mutantsOf(report)].filter((found) => found.mutant.status === "Timeout");
  return (proven[shard] ?? []).filter((hang) => !timeouts.some((found) => matches(hang, found)));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const partial = args.includes("--partial");
  const shard = process.env.MUTATION_SHARD ?? "leases";
  const path = args.find((one) => !one.startsWith("--")) ?? `reports/mutation/${shard}.json`;
  const report = JSON.parse(readFileSync(path, "utf8"));
  const unproven = unprovenTimeouts(report, shard);
  const errored = erroredMutants(report);
  const stale = partial ? [] : staleHangs(report, shard);
  if (unproven.length > 0)
    console.error(
      `Timeouts of shard ${shard} that are not proven hangs (a Timeout counts as killed, and hid survivors: agbossjs/mongodb#103) — kill each with a test, or prove it a hang in scripts/stryker-timeouts.mjs:\n  ${unproven.join("\n  ")}`,
    );
  if (errored.length > 0)
    console.error(
      `Mutants of shard ${shard} that ended in an error, which Stryker leaves out of the score — find why and kill them:\n  ${errored.join("\n  ")}`,
    );
  if (stale.length > 0)
    console.error(
      `PROVEN_HANGS of shard ${shard} that no Timeout of the report matches (remove them):\n  ${stale
        .map(
          (hang) =>
            `${hang.file} ${hang.mutator} -> ${hang.replacement} ${JSON.stringify(hang.anchor)}`,
        )
        .join("\n  ")}`,
    );
  if (unproven.length > 0 || errored.length > 0 || stale.length > 0) process.exit(1);
  console.log(
    `Timeouts of shard ${shard}: every one is a proven hang, and no mutant ended in an error`,
  );
}
