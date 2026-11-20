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

/** The files no shard mutates, reviewed. */
const NON_SHARDED_SRC: Readonly<Record<string, string>> = {
  "src/index.ts": "the exports",
  "src/errors.ts": "the named errors: constructors of codes and messages",
  "src/redaction.ts": "the redaction of the URL in messages, covered by its own tests",
  "src/stores/bundles.ts": "the thread's bundles of the record store: not a money path",
  // the stores of no money path (their own contracts and tests; not sharded in agbossjs/agboss#1213)
  ...Object.fromEntries(
    [
      "src/stores/a2a-direct-messages/a2a-direct-message-documents.ts",
      "src/stores/a2a-direct-messages/a2a-direct-message-save.ts",
      "src/stores/a2a-direct-messages/a2a-direct-message-sweep.ts",
      "src/stores/a2a-tasks/a2a-message-save.ts",
      "src/stores/a2a-tasks/a2a-task-documents.ts",
      "src/stores/a2a-tasks/a2a-task-pages.ts",
      "src/stores/a2a-tasks/a2a-task-sweep.ts",
      "src/stores/audit-log/audit-event-documents.ts",
      "src/stores/checkpoints/checkpoint-documents.ts",
      "src/stores/checkpoints/latest-checkpoint.ts",
      "src/stores/checkpoints/write-operations.ts",
      "src/stores/history/history-documents.ts",
      "src/stores/mongo-a2a-direct-message.repository.ts",
      "src/stores/mongo-a2a-task.repository.ts",
      "src/stores/mongo-checkpoint-saver.ts",
      "src/stores/mongo-execution-audit-log.repository.ts",
      "src/stores/mongo-execution-history.repository.ts",
      "src/stores/mongo-execution-record.repository.ts",
      "src/stores/mongo-execution-tree.repository.ts",
      "src/stores/mongo-mesh-request.repository.ts",
      "src/stores/records/record-documents.ts",
      "src/stores/records/record-memory.ts",
      "src/stores/records/record-reads.ts",
      "src/stores/records/record-scores.ts",
      "src/stores/records/record-writes.ts",
    ].map((file) => [file, "a store of no money path"]),
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
