#!/usr/bin/env node
// Changelog fragments (agbossjs/agboss#981; vendored from agbossjs/agboss scripts/changelog-assemble.mjs,
// keep the two identical below this note): every PR adds `changes/<issue>-<slug>.md` instead of editing
// CHANGELOG.md, so parallel PRs never conflict. At release this script folds the fragments into the
// `## [<version>]` section of CHANGELOG.md (an existing `— unreleased` one, or a new one) and deletes them.
//
//   node scripts/changelog-assemble.mjs <version> [--date YYYY-MM-DD] [--dir changes] [--changelog CHANGELOG.md]
//   node scripts/changelog-assemble.mjs --check [--dir changes]     validate the fragments only
//
// Format: see changes/README.md. A fragment with an unknown section, a file name that disagrees with
// its `issue`, or an entry that does not mention its issue fails the run and changes nothing.
// Idempotent: with no fragments left only an unreleased heading is dated (nothing else is touched). The file is
// replaced atomically and the fragments are deleted after, so a crash in between is repaired by a rerun.
// `changes/config.json` names the form an entry must mention its issue in (`#981`, or
// `agbossjs/agboss#981` in a repository other than the core).
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { foldFragments, SECTIONS } from "./changelog-fold.mjs";

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
export function parseFragment(file, text, prefix) {
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
  const lead = /^\w/.test(prefix) ? "(?<![\\w/])" : "";
  const mention = new RegExp(
    `${lead}${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${issue}(?!\\d)`,
  );
  if (!mention.test(body)) fail(`the entry must mention ${prefix}${issue}`);
  return { file, section, issue: Number(issue), entry: body };
}

/** The form an entry mentions its issue in, from `<dir>/config.json` (`{ "issuePrefix": "#" }`). */
export function readPrefix(dir) {
  const path = join(dir, "config.json");
  if (!existsSync(path))
    throw new Error(`${path} is missing: it names the issue form, { "issuePrefix": "#" }`);
  const prefix = JSON.parse(readFileSync(path, "utf8")).issuePrefix;
  if (typeof prefix !== "string" || !prefix.endsWith("#"))
    throw new Error(`${path}: issuePrefix must end with #`);
  return prefix;
}

/** Read and validate every fragment of a directory (README.md and dotfiles are not fragments). */
export function readFragments(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => name !== "README.md" && name !== "config.json" && !name.startsWith("."))
    .sort();
  const prefix = readPrefix(dir);
  return files.map((name) => parseFragment(name, readFileSync(join(dir, name), "utf8"), prefix));
}

/** Write `text` to a temp file beside `path`, then rename it over: a crash never leaves a torn file. */
function replaceFile(path, text) {
  const exists = existsSync(path);
  if (exists) accessSync(path, constants.W_OK);
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, text);
    if (exists) chmodSync(temp, statSync(path).mode);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
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
  const date = option(args, "--date", new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date ${date} is not YYYY-MM-DD`);
  const path = option(args, "--changelog", "CHANGELOG.md");
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const after = foldFragments(before, version, date, fragments);
  if (after !== before) replaceFile(path, after);
  if (fragments.length === 0) {
    const dated = after === before ? "nothing to assemble" : `${version} dated ${date}`;
    console.log(`no fragments in ${dir}/: ${dated}`);
    return;
  }
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
