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
 * The files no shard mutates, reviewed, each with what it is and why it is not mutated (agbossjs/mongodb#104, #105:
 * "a store of no money path" is said only of what has no once-only claim and no compare-and-set that a caller
 * without the lease depends on; the execution tree store has one, written by user code in any execution of the tree
 * and by overlapping passes, so it is a shard).
 */
const NON_SHARDED_SRC: Readonly<Record<string, string>> = {
  "src/index.ts": "the exports: no logic",
  "src/errors.ts":
    "the named errors: constructors that build a code and a message from one options object; tests/errors walks every export",
  "src/redaction.ts":
    "the mask of a password in a printed text: byte for byte the twin of agbossjs/postgres's, with its 500 seeded draws; a run of it as a shard found 12 survivors, equivalent ones among them (a regex's split on one space or a run, bounds no input reaches), whose rewrite must be made in both packages: agbossjs/mongodb#105",
  "src/stores/bundles.ts":
    "the store classes as two lists for `@Application({ providers })`: imports and arrays, no logic",
  // append-only logs and last-write stores: no once-only claim, no compare-and-set
  "src/stores/audit-log/audit-event-documents.ts":
    "the audit log's document as read back: the shapes of the four kinds of event and the old names of an outbound call's outcomes; no write, no claim",
  "src/stores/mongo-execution-audit-log.repository.ts":
    "the append-only audit log: one insert per event and a sweep by cutoff; no once-only claim and no compare-and-set",
  "src/stores/history/history-documents.ts":
    "the history's document as read back: its JSON record checked by the core, an unreadable one named; no write, no claim",
  "src/stores/mongo-execution-history.repository.ts":
    "the history of root executions: one replace with upsert (the last save wins), reads, a sweep of ended ones; no claim",
  "src/stores/records/record-memory.ts":
    "the memory summaries of the record store: reads, and one insert of a summary under a fresh random id; no claim",
  "src/stores/records/record-reads.ts": "the reads of the record store: no write",
  "src/stores/records/record-scores.ts":
    "scores, their summaries and the config snapshot: one insert per score and derived numbers; the snapshot is an upsert by its own hash, and what it feeds is a diagnostic only (the drift warning at start and the snapshots listed), which no run and no payment depends on, so which of two writers lands first is no guarantee",
  "src/stores/records/record-documents.ts":
    "the record store's documents: shapes, their conversions and one read of a record's `seq`; no claim",
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
