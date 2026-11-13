// Folding changelog fragments into CHANGELOG.md (#981; used by changelog-assemble.mjs, vendored with it).
// A version's section is either absent (a new one is written above the newest release), unreleased
// (`## [0.1.1] — unreleased`, or the older `## [Unreleased] — 0.1.1 (…)`: the fragments go under its
// `### <Section>` subheadings and the heading gets the date), or released (nothing may be added).
// A fragment whose bullet is already in the section was folded by an earlier, interrupted run.

/** Section name in a fragment → its heading in CHANGELOG.md, in the order they are written. */
export const SECTIONS = new Map([
  ["Breaking", "Changed — breaking"],
  ["Changed", "Changed"],
  ["Added", "Added"],
  ["Fixed", "Fixed"],
  ["Deprecated", "Deprecated"],
  ["Security", "Security"],
]);

const HEADINGS = [...SECTIONS.values()];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const blank = (line) => line.trim() === "";

/** The `- ` bullet of one entry: continuation lines indent by two spaces, blank lines stay blank. */
export function bulletOf(entry) {
  return entry
    .split("\n")
    .map((line, i) => (i === 0 ? `- ${line}` : line === "" ? "" : `  ${line}`))
    .join("\n");
}

const byIssue = (a, b) => a.issue - b.issue || (a.file < b.file ? -1 : 1);

/** The release section for already parsed fragments. */
export function sectionOf(version, date, fragments) {
  const parts = [`## [${version}] — ${date}`];
  for (const [name, heading] of SECTIONS) {
    const own = fragments.filter((fragment) => fragment.section === name).sort(byIssue);
    if (own.length) parts.push(`### ${heading}\n\n${own.map((f) => bulletOf(f.entry)).join("\n")}`);
  }
  return `${parts.join("\n\n")}\n`;
}

/** Where a subheading sits in the canonical order; a custom one ("Fixed — other") sits with its kind. */
function rank(heading) {
  let best = -1;
  for (const [i, own] of HEADINGS.entries()) {
    const kin = heading === own || heading.startsWith(`${own} `);
    if (kin && (best === -1 || own.length > HEADINGS[best].length)) best = i;
  }
  return best === -1 ? Infinity : best;
}

/** The `## ` section of a version as line indexes, or null. `released` is false for an unreleased one. */
function findSection(lines, version) {
  const v = escape(version);
  const own = new RegExp(`^## \\[${v}\\](.*)$|^## \\[Unreleased\\] — ${v}(?![\\w.-])(.*)$`);
  const start = lines.findIndex((line) => own.test(line));
  if (start === -1) return null;
  const next = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  const unreleased = /^## \[[^\]]+\] — unreleased\s*$|^## \[Unreleased\] — /i.test(lines[start]);
  return { start, end: next === -1 ? lines.length : next, released: !unreleased };
}

/** The section's lines after its heading: the intro, then `{ heading, lines }` per `### `. */
function split(body) {
  const intro = [];
  const blocks = [];
  for (const line of body) {
    if (line.startsWith("### ")) blocks.push({ heading: line.slice(4).trim(), lines: [] });
    else (blocks.at(-1)?.lines ?? intro).push(line);
  }
  const trim = (lines) => {
    const from = lines.findIndex((line) => !blank(line));
    if (from === -1) return [];
    let to = lines.length;
    while (blank(lines[to - 1])) to -= 1;
    return lines.slice(from, to);
  };
  return { intro: trim(intro), blocks: blocks.map((b) => ({ ...b, lines: trim(b.lines) })) };
}

/** Add the bullets of one canonical section to the blocks: append to its `###`, or create it in order. */
function addTo(blocks, heading, bullets) {
  const own = blocks.find((block) => block.heading === heading);
  if (!own) {
    const block = { heading, lines: bullets.join("\n").split("\n") };
    const at = blocks.findIndex((b) => rank(b.heading) > rank(heading));
    blocks.splice(at === -1 ? blocks.length : at, 0, block);
    return;
  }
  const loose = own.lines.some(
    (line, i) => line.startsWith("- ") && blank(own.lines[i - 1] ?? "-"),
  );
  own.lines.push(
    ...bullets.flatMap((bullet) => (loose ? ["", ...bullet.split("\n")] : bullet.split("\n"))),
  );
}

/**
 * CHANGELOG.md with the fragments folded into the section of `version`.
 * Throws when the version is already released and a fragment is not in it yet.
 */
export function foldFragments(changelog, version, date, fragments) {
  const text = changelog === "" ? "# Changelog\n" : changelog;
  const lines = text.replace(/\n$/, "").split("\n");
  const found = findSection(lines, version);
  if (!found) {
    const first = lines.findIndex((line) => line.startsWith("## ["));
    const section = sectionOf(version, date, fragments);
    if (first === -1) return `${text.trimEnd()}\n\n${section}`;
    return `${lines.slice(0, first).join("\n")}\n${section}\n${lines.slice(first).join("\n")}\n`;
  }
  const own = lines.slice(found.start + 1, found.end);
  const has = (fragment) => `\n${own.join("\n")}\n`.includes(`\n${bulletOf(fragment.entry)}\n`);
  const fresh = fragments.filter((fragment) => !has(fragment));
  if (found.released) {
    if (fresh.length) throw new Error(`CHANGELOG.md already has a section for ${version}`);
    return text;
  }
  const { intro, blocks } = split(own);
  for (const [name, heading] of SECTIONS) {
    const bullets = fresh
      .filter((f) => f.section === name)
      .sort(byIssue)
      .map((f) => bulletOf(f.entry));
    if (bullets.length) addTo(blocks, heading, bullets);
  }
  const out = [`## [${version}] — ${date}`, ""];
  if (intro.length) out.push(...intro, "");
  for (const block of blocks) out.push(`### ${block.heading}`, "", ...block.lines, "");
  const after = lines.slice(found.end);
  return `${[...lines.slice(0, found.start), ...out, ...after].join("\n").trimEnd()}\n`;
}
