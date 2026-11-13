#!/usr/bin/env node
// Changelog fragments (agbossjs/agboss#981; vendored from agbossjs/agboss scripts/changelog-assemble.mjs,
// keep the two identical below this note): every PR adds `changes/<issue>-<slug>.md` instead of editing
// CHANGELOG.md, so parallel PRs never conflict. At release this script folds the fragments into one
// `## [<version>] — <date>` section of CHANGELOG.md, in a fixed section order, and deletes them.
//
//   node scripts/changelog-assemble.mjs <version> [--date YYYY-MM-DD] [--dir changes] [--changelog CHANGELOG.md]
//   node scripts/changelog-assemble.mjs --check [--dir changes]     validate the fragments only
//
// Format: see changes/README.md. A fragment with an unknown section, a file name that disagrees with
// its `issue`, or an entry that does not mention its issue fails the run and changes nothing.
// Idempotent: with no fragments left there is nothing to do and the file is not touched.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Section name in a fragment → its heading in CHANGELOG.md, in the order they are written. */
export const SECTIONS = new Map([
  ["Breaking", "Changed — breaking"],
  ["Changed", "Changed"],
  ["Added", "Added"],
  ["Fixed", "Fixed"],
  ["Deprecated", "Deprecated"],
  ["Security", "Security"],
]);

const NAME = /^(\d+)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/** The header of a fragment as a Map, and its body; throws on a malformed header. */
function splitFragment(fail, text) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!match) fail("must start with a --- header holding `section` and `issue`");
  const header = new Map();
  for (const line of match[1].split("\n")) {
    const pair = /^(\w+):\s*(.*?)\s*$/.exec(line);
    if (!pair) fail(`header line "${line}" is not "key: value"`);
    if (header.has(pair[1])) fail(`header key "${pair[1]}" appears twice`);
    if (pair[1] !== "section" && pair[1] !== "issue") fail(`unknown header key "${pair[1]}"`);
    header.set(pair[1], pair[2]);
  }
  return { header, body: match[2].replace(/^\n+/, "").trimEnd() };
}

/** Parse one fragment; throws an Error naming the file when it is malformed. */
export function parseFragment(file, text) {
  const fail = (why) => {
    throw new Error(`${file}: ${why}`);
  };
  const named = NAME.exec(file);
  if (!named) fail("the name must be <issue>-<slug>.md (lowercase, digits, hyphens)");
  const { header, body } = splitFragment(fail, text);
  const section = header.get("section");
  if (!SECTIONS.has(section)) {
    fail(`unknown section "${section ?? ""}" (one of: ${[...SECTIONS.keys()].join(", ")})`);
  }
  const issue = header.get("issue") ?? "";
  if (issue !== named[1]) fail(`\`issue: ${issue}\` must equal the file name's ${named[1]}`);
  if (!body) fail("the entry text is empty");
  if (!new RegExp(`#${issue}(?!\\d)`).test(body)) fail(`the entry must mention #${issue}`);
  return { file, section, issue: Number(issue), entry: body };
}

/** The `- ` bullet of one entry: continuation lines indent by two spaces, blank lines stay blank. */
function bulletOf(entry) {
  return entry
    .split("\n")
    .map((line, i) => (i === 0 ? `- ${line}` : line === "" ? "" : `  ${line}`))
    .join("\n");
}

/** The release section for already parsed fragments. */
export function sectionOf(version, date, fragments) {
  const parts = [`## [${version}] — ${date}`];
  for (const [name, heading] of SECTIONS) {
    const own = fragments
      .filter((fragment) => fragment.section === name)
      .sort((a, b) => a.issue - b.issue || (a.file < b.file ? -1 : 1));
    if (own.length) parts.push(`### ${heading}\n\n${own.map((f) => bulletOf(f.entry)).join("\n")}`);
  }
  return `${parts.join("\n\n")}\n`;
}

const HEAD = "# Changelog\n";

/** CHANGELOG.md with the release section above the newest release; throws if the version exists. */
export function insertSection(changelog, version, section) {
  const text = changelog === "" ? HEAD : changelog;
  const heading = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "m");
  if (heading.test(text)) throw new Error(`CHANGELOG.md already has a section for ${version}`);
  const first = /^## \[/m.exec(text);
  if (!first) return `${text.trimEnd()}\n\n${section}`;
  return `${text.slice(0, first.index)}${section}\n${text.slice(first.index)}`;
}

/** Read and validate every fragment of a directory (README.md and dotfiles are not fragments). */
export function readFragments(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => name !== "README.md" && !name.startsWith("."))
    .sort();
  return files.map((name) => parseFragment(name, readFileSync(join(dir, name), "utf8")));
}

function option(args, name, fallback) {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
}

function main(args) {
  const dir = option(args, "--dir", "changes");
  const fragments = readFragments(dir);
  if (args.includes("--check")) {
    console.log(`${fragments.length} changelog fragment(s) valid`);
    return;
  }
  const version = args.find((arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!version || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
    throw new Error(
      "usage: changelog-assemble.mjs <version> [--date YYYY-MM-DD] [--dir D] [--changelog F]",
    );
  }
  if (fragments.length === 0) {
    console.log(`no fragments in ${dir}/: nothing to assemble`);
    return;
  }
  const date = option(args, "--date", new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date ${date} is not YYYY-MM-DD`);
  const path = option(args, "--changelog", "CHANGELOG.md");
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const after = insertSection(before, version, sectionOf(version, date, fragments));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, after);
  for (const fragment of fragments) rmSync(join(dir, fragment.file));
  console.log(`${path}: ${version} assembled from ${fragments.length} fragment(s)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
