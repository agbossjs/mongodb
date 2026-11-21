#!/usr/bin/env node
// A Timeout is a hang, and an error is not a pass (#1367). Stryker counts a Timeout as killed, and a mutant no test
// kills has to run every test that covers it: when that run is longer than Stryker's limit (`timeoutFactor` x the
// covering tests' net time + `timeoutMS`; the net time leaves out hooks and setup), the survivor reads as a Timeout and
// the score never shows it (agbossjs/mongodb#103: half of a shard's sampled Timeouts survived alone). `RuntimeError` and
// `CompileError` are left out of the score altogether: a shard whose mutants all errored still reads 100 %. The
// shards' config sets the limit above the whole run, so what is still a Timeout did not finish, and this check fails
// a report that holds a Timeout of the clock, a RuntimeError or a CompileError that nobody justified:
//   - a Timeout Stryker ended by its hit limit ("Hit limit reached": the mutated code ran 100 x as often as in the dry
//     run, a loop that does not end) never waited on a time limit, so it cannot be a survivor that ran too long: it is
//     counted and told, not listed. Whether it shows as one or as Killed depends on the race between Stryker's count
//     and a test that fails first (the same shard ran both ways in two cold runs), so a list of them would flake;
//   - an entry of `PROVEN_HANGS` (scripts/stryker-proven-hangs.json, a JSON array) names any other mutant by its
//     shard, file, mutator, replacement, an anchor (a snippet of the mutated line, or of it and the next: a short one such
//     as `try {` takes the line below) and a kind — `wall-clock` (the time limit ended it: a loop Stryker cannot count,
//     such as a `settled()` that awaits a settled promise for ever; run alone with 3 x the shard's run it still did not
//     finish), `runtime-error` or `compile-error` — and a reason. Never by the mutant's id, which a run numbers afresh,
//     or its line, which an edit moves;
//   - both ways: a mutant that matches no entry fails, and an entry of the report's shard that matches no mutant, or a
//     Survived one, is stale and fails (one whose mutant was Killed this time is told, not failed); `--partial` skips
//     that half for a run of part of a shard.
// Self-contained: the list is a JSON file beside the script, `--hangs <file>` names another. The stores copy both as they are.
// `node scripts/stryker-timeouts.mjs [--partial] [--hangs <file>] <report.json> [...]` checks Stryker JSON reports
// (reporters: json); a report's shard is its file's name without `.json`.
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HANGS = join(here, "stryker-proven-hangs.json");
const KINDS = ["wall-clock", "runtime-error", "compile-error"];
const FIELDS = ["shard", "file", "mutator", "replacement", "anchor", "kind", "reason"];
const identityOf = (hang) =>
  JSON.stringify([hang.shard, hang.file, hang.mutator, hang.replacement, hang.anchor, hang.kind]);

/** The entries of a proven-hangs list that lack a field, name an unknown kind, or are there twice. */
export function problemsOfList(hangs) {
  if (!Array.isArray(hangs)) return ["PROVEN_HANGS is not an array"];
  const problems = [];
  const seen = new Set();
  hangs.forEach((hang, index) => {
    const at = `PROVEN_HANGS[${String(index)}]`;
    const missing =
      hang === null || typeof hang !== "object"
        ? FIELDS
        : FIELDS.filter((field) => typeof hang[field] !== "string" || hang[field].trim() === "");
    if (missing.length > 0) problems.push(`${at}: needs ${missing.join(", ")}`);
    else if (!KINDS.includes(hang.kind))
      problems.push(`${at}: kind "${hang.kind}" is none of ${KINDS.join(", ")}`);
    else if (seen.has(identityOf(hang)))
      problems.push(`${at}: ${hang.file} ${hang.anchor} is listed twice`);
    else seen.add(identityOf(hang));
  });
  return problems;
}

const isReport = (report) =>
  report !== null &&
  typeof report === "object" &&
  report.files !== null &&
  typeof report.files === "object";

/** The line a mutant starts on and the next one, trimmed: an anchor too short to be its own (`try {`) takes the line below. */
const textOf = (lines, line) =>
  [lines[line - 1], lines[line]]
    .map((one) => (one ?? "").trim())
    .join(" ")
    .trim();

/** What a mutant that is neither killed, survived nor ignored is, as an entry's `kind`; `undefined` for the others. */
function kindOf(mutant) {
  if (mutant.status === "Timeout")
    return String(mutant.statusReason ?? "").startsWith("Hit limit reached")
      ? "hit-limit"
      : "wall-clock";
  if (mutant.status === "RuntimeError") return "runtime-error";
  if (mutant.status === "CompileError") return "compile-error";
  return undefined;
}

/** The mutants of a report that are not killed or survived, with the text of the line each starts on. */
function badMutantsOf(report) {
  return Object.entries(report.files).flatMap(([file, { mutants, source }]) => {
    const lines = typeof source === "string" ? source.split("\n") : [];
    return mutants.flatMap((mutant) => {
      const kind = kindOf(mutant);
      if (kind === undefined) return [];
      const line = mutant.location.start.line;
      return [{ file, mutant, kind, line, text: textOf(lines, line) }];
    });
  });
}

const matches = (hang, shard, found) =>
  hang.shard === shard &&
  hang.file === found.file &&
  hang.mutator === found.mutant.mutatorName &&
  hang.replacement === String(found.mutant.replacement) &&
  hang.kind === found.kind &&
  found.text.includes(hang.anchor);

const describeBad = (found) =>
  `${found.file}:${String(found.line)}: ${found.mutant.status} (${found.kind}) of a ${found.mutant.mutatorName} mutant -> ${String(found.mutant.replacement)}` +
  `${found.mutant.statusReason === undefined ? "" : ` [${String(found.mutant.statusReason)}]`}; line: ${found.text}`;

/**
 * The entries of `shard` that no mutant of the report matches: stale. An entry whose mutant is there but Killed
 * is not: a loop of wall-clock hangs ended by the time limit this run may be ended by a test the next, so it is told in
 * the output, never failed.
 */
function staleOf(name, shard, report, hangs, bad) {
  const identity = (hang, found) =>
    hang.shard === shard &&
    hang.file === found.file &&
    hang.mutator === found.mutator &&
    hang.replacement === found.replacement &&
    found.text.includes(hang.anchor);
  const all = Object.entries(report.files).flatMap(([file, { mutants, source }]) => {
    const lines = typeof source === "string" ? source.split("\n") : [];
    return mutants.map((mutant) => ({
      file,
      mutator: mutant.mutatorName,
      replacement: String(mutant.replacement),
      status: mutant.status,
      text: textOf(lines, mutant.location.start.line),
    }));
  });
  const problems = [];
  for (const hang of hangs) {
    if (hang.shard !== shard || bad.some((found) => matches(hang, shard, found))) continue;
    const there = all.filter((found) => identity(hang, found));
    if (there.length === 0 || there.some((found) => found.status === "Survived"))
      problems.push(
        `${name}: PROVEN_HANGS has ${hang.file} ${hang.mutator} -> ${hang.replacement} (${hang.kind}, "${hang.anchor}") that matches ${there.length === 0 ? "no mutant" : "a Survived mutant"} of this report: stale, remove it`,
      );
    else
      console.log(
        `${name}: note: ${hang.file} "${hang.anchor}" (${hang.kind}) was ${there[0].status} in this run, not ended as listed`,
      );
  }
  return problems;
}

/** The problems of one report of `shard`: its unjustified mutants, and (unless `partial`) the entries of the shard that match none. */
function auditReport(name, shard, report, hangs, partial) {
  if (!isReport(report)) return [`${name}: not a Stryker JSON report (no "files")`];
  const found = badMutantsOf(report);
  const counted = found.filter((one) => one.kind === "hit-limit");
  if (counted.length > 0)
    console.log(
      `${name}: ${String(counted.length)} Timeouts of Stryker's hit limit (loops that do not end), not listed`,
    );
  const bad = found.filter((one) => one.kind !== "hit-limit");
  const problems = bad
    .filter((found) => !hangs.some((hang) => matches(hang, shard, found)))
    .map(
      (found) =>
        `${name}: ${describeBad(found)}. A survivor reads as a Timeout when its run outlasts the limit: run it alone with a limit of 3 x the shard's run; if it survives, kill it with a test; if it still does not finish, add it to PROVEN_HANGS (shard ${shard}) with the reason; an error is a mutant no test judged: find out why`,
    );
  if (!partial) problems.push(...staleOf(name, shard, report, hangs, bad));
  return problems;
}

/**
 * The violations of `reports` (parsed Stryker JSON, `{ name, shard, report }`) against `hangs`, as one line each; empty
 * when every Timeout, RuntimeError and CompileError is on the list and every entry of a reported shard still matches one.
 * @param {readonly { name: string, shard: string, report: any }[]} reports
 * @param {readonly { shard: string, file: string, mutator: string, replacement: string, anchor: string, kind: string, reason: string }[]} hangs
 * @param {{ partial?: boolean }} [options]
 * @returns {string[]}
 */
export function auditTimeouts(reports, hangs, options = {}) {
  const listed = problemsOfList(hangs);
  if (listed.length > 0) return listed;
  return reports.flatMap(({ name, shard, report }) =>
    auditReport(name, shard, report, hangs, options.partial === true),
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  let hangsFile = DEFAULT_HANGS;
  let partial = false;
  const paths = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--hangs") hangsFile = resolve(args[(index += 1)] ?? "");
    else if (args[index] === "--partial") partial = true;
    else paths.push(args[index]);
  }
  if (paths.length === 0) {
    console.error(
      "usage: node scripts/stryker-timeouts.mjs [--partial] [--hangs <file>] <report.json> [...]",
    );
    process.exit(2);
  }
  const PROVEN_HANGS = JSON.parse(readFileSync(hangsFile, "utf8"));
  const reports = paths.map((path) => ({
    name: path,
    shard: basename(path, ".json"),
    report: JSON.parse(readFileSync(path, "utf8")),
  }));
  const problems = auditTimeouts(reports, PROVEN_HANGS, { partial });
  if (problems.length > 0) {
    console.error(
      `Stryker Timeouts and errors (#1367) — a Timeout is a proven hang, an error is justified:\n  ${problems.join("\n  ")}`,
    );
    process.exit(1);
  }
  console.log(
    `Stryker Timeouts: no Timeout or error of ${paths.join(", ")} but the proven ones (${String(PROVEN_HANGS.length)} listed)`,
  );
}
