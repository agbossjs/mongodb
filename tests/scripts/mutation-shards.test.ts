/**
 * agbossjs/agboss#91 (the twin of agbossjs/postgres#127): every file of `src/` is mutated by a
 * shard of `scripts/mutation-shards.mjs`, or is named below with the reason it is not — so a
 * module added to `src/` (a helper of a money path pulled out of a shard's file) is a conscious
 * decision of a shard, never a file no mutant reaches.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { describe, expect, it } from "vitest";
import { SHARDS } from "../../scripts/mutation-shards.mjs";

/**
 * The files no shard mutates, reviewed, each with what it is and why it is not mutated yet (agbossjs/mongodb#104:
 * "a store of no money path" was said of stores that have a once-only claim; it is said now only of what has none).
 */
const FOLLOW_UP = "not sharded yet: agbossjs/mongodb#105";

const NON_SHARDED_SRC: Readonly<Record<string, string>> = {
  "src/index.ts": "the exports: no logic",
  "src/errors.ts": "the named errors: constructors of codes and messages, checked by tests/errors",
  "src/redaction.ts":
    "the mask of a password in a printed text: byte for byte the twin of agbossjs/postgres's, with its 500 seeded draws; a run of it as a shard found 12 survivors, equivalent ones among them (a regex's split on one space or a run, bounds no input reaches), whose rewrite must be made in both packages: agbossjs/mongodb#105",
  "src/stores/bundles.ts":
    "the thread's bundles of the record store: a read-model of records, no claim and no order a payment depends on",
  // append-only logs and last-write stores: no once-only claim, no compare-and-set
  "src/stores/audit-log/audit-event-documents.ts":
    "the audit log's document: an insert of what happened, ordered by the sequence (`ordering` shard); no claim",
  "src/stores/mongo-execution-audit-log.repository.ts":
    "the append-only audit log: one insert per event and a sweep by cutoff; no once-only claim and no compare-and-set",
  "src/stores/history/history-documents.ts":
    "the history's document: the record as JSON beside its keys; the same record saved twice keeps the last",
  "src/stores/mongo-execution-history.repository.ts":
    "the history of root executions: one replace with upsert (the last save wins), reads, a sweep of ended ones; no claim",
  "src/stores/records/record-memory.ts":
    "the memory summaries of the record store: derived text, no claim",
  "src/stores/records/record-reads.ts": "the reads of the record store: no write",
  "src/stores/records/record-scores.ts":
    "scores, their summaries and the config snapshot's drift: derived numbers; the claim of a snapshot is the first write",
  "src/stores/records/record-documents.ts":
    "the record store's documents: shapes and their conversions",
  // once-only claims and compare-and-set: the work of agbossjs/mongodb#105
  ...Object.fromEntries(
    [
      ["src/stores/a2a-tasks/a2a-message-save.ts", "the once-only save of an accepted message"],
      [
        "src/stores/a2a-tasks/a2a-task-documents.ts",
        "the task's documents and its terminal states",
      ],
      ["src/stores/a2a-tasks/a2a-task-pages.ts", "the task listing's pages"],
      ["src/stores/a2a-tasks/a2a-task-sweep.ts", "the retention of terminal tasks"],
      [
        "src/stores/mongo-a2a-task.repository.ts",
        "`saveIfAbsent` (one transaction: of two pods accepting one message one saves it) and `compareAndSetStatus` (a terminal status is never written over)",
      ],
      [
        "src/stores/mongo-execution-record.repository.ts",
        "`completeIfStatus` (the status write that must not land late) and a thread id created once",
      ],
      [
        "src/stores/records/record-writes.ts",
        "a thread created once, `completeIfStatus`, the once-per-step pause log",
      ],
      [
        "src/stores/mongo-execution-tree.repository.ts",
        "`saveIfAbsentInTree`: of two instances saving one key exactly one inserts it",
      ],
      [
        "src/stores/mongo-mesh-request.repository.ts",
        "`saveIfAbsent`: of two instances admitting one idempotency key exactly one runs the request",
      ],
    ].map(([file = "", what = ""]) => [file, `${what}; ${FOLLOW_UP}`]),
  ),
};

const sourcesOf = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourcesOf(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );

describe("agbossjs/agboss#91: the mutation shards cover src/", () => {
  const patterns = Object.values(SHARDS).flatMap((shard) => shard.mutate);
  const sources = sourcesOf("src");

  it("every file of src/ is mutated by a shard or reviewed as not", () => {
    const loose = sources.filter(
      (file) =>
        !patterns.some((pattern) => matchesGlob(file, pattern)) && !(file in NON_SHARDED_SRC),
    );

    expect(loose).toEqual([]);
  });

  it("a file named as not sharded is a file that exists and no shard mutates", () => {
    const stale = Object.keys(NON_SHARDED_SRC).filter(
      (file) => !sources.includes(file) || patterns.some((pattern) => matchesGlob(file, pattern)),
    );

    expect(stale).toEqual([]);
  });

  it("every pattern of a shard matches a file", () => {
    const empty = patterns.filter((pattern) => !sources.some((file) => matchesGlob(file, pattern)));

    expect(empty).toEqual([]);
  });
});

describe("agbossjs/mongodb#100: a cached result cannot hide a survivor from the nightly run", () => {
  const nightly = readFileSync(".github/workflows/mutation-nightly.yml", "utf8");

  it("the nightly run is cold: every mutant is tested again", () => {
    expect(nightly).toContain("npm run test:mutation -- --force");
  });

  it("and restores no cache of results", () => {
    expect(nightly).not.toContain("actions/cache");
    expect(nightly).not.toContain("stryker-incremental");
  });

  it("every shard of the CI is a shard of the nightly run, and the other way round", () => {
    const listed = (file: string): string[] => {
      const matrix =
        /shard:\s*\[([^\]]*\bleases\b[^\]]*)\]/u.exec(readFileSync(file, "utf8"))?.[1] ?? "";
      return matrix
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
        .sort();
    };

    expect(listed(".github/workflows/mutation-nightly.yml")).toEqual(Object.keys(SHARDS).sort());
    expect(listed(".github/workflows/ci.yml")).toEqual(Object.keys(SHARDS).sort());
  });
});
