// A copy of agbossjs/agboss scripts/docs/snippets.mjs (#196, agbossjs/agboss#1213): keep the two alike.
// Fenced code blocks of a Markdown file, read as snippets (#196). The conventions:
//   ```ts                       compiled as a module of its own
//   ```ts file=src/a.ts         written at that path in the doc's folder: other snippets of the same
//                               doc import it (`./a.js`); any language (a prompt `md`, a `json`)
//   ```ts no-check: <reason>    not compiled; the reason is required
//   <!-- snippet-context        hidden lines right before a fence: put before the snippet, or around
//   import { from } from "@agboss/core";      it when a line `// @snippet` marks where it goes
//   -->
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const CONTEXT_OPEN = "<!-- snippet-context";
const PLACEHOLDER = /^\s*\/\/ @snippet\s*$/;
const COMPILED = new Set(["ts", "typescript"]);

/** `ts file=a.ts no-check: why` → its language, file and opt-out reason. */
function infoOf(info) {
  const [lang = "", ...rest] = info.trim().split(/\s+/);
  const words = rest.join(" ");
  const file = /(?:^|\s)file=(\S+)/.exec(words)?.[1];
  const noCheck = /(?:^|\s)no-check\b[\s:—-]*(.*)$/.exec(words);
  return { lang: lang.toLowerCase(), file, noCheck: noCheck ? noCheck[1].trim() : undefined };
}

/** The hidden `<!-- snippet-context … -->` lines just above line `fence`, split at `// @snippet`. */
function contextBefore(lines, fence) {
  let end = fence - 1;
  while (end >= 0 && lines[end].trim() === "") end -= 1;
  if (end < 0 || lines[end].trim() !== "-->") return { before: [], after: [] };
  let start = end - 1;
  while (start >= 0 && lines[start].trim() !== CONTEXT_OPEN) start -= 1;
  if (start < 0) return { before: [], after: [] };
  const body = lines.slice(start + 1, end);
  const at = body.findIndex((line) => PLACEHOLDER.test(line));
  return at < 0
    ? { before: body, after: [] }
    : { before: body.slice(0, at), after: body.slice(at + 1) };
}

/** The line closing the fence opened at `open`, or the last line. */
function closeOf(lines, open, marker, indent) {
  for (let i = open + 1; i < lines.length; i += 1) {
    const line = lines[i].slice(Math.min(indent.length, lines[i].search(/\S|$/)));
    if (line.startsWith(marker) && line.slice(marker.length).trim() === "") return i;
  }
  return lines.length;
}

function snippetAt(lines, open, close, match, doc) {
  const [, indent, , info] = match;
  const { lang, file, noCheck } = infoOf(info);
  const code = lines
    .slice(open + 1, close)
    .map((line) => line.slice(Math.min(indent.length, line.search(/\S|$/))));
  const { before, after } = contextBefore(lines, open);
  return {
    doc,
    line: open + 2,
    lang,
    file,
    noCheck,
    compiled: COMPILED.has(lang) && noCheck === undefined,
    code,
    before,
    after,
  };
}

/** Every fenced block of `markdown` (`doc` names it in problems), with its first code line. */
export function snippetsOf(markdown, doc) {
  const lines = markdown.split("\n");
  const snippets = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = FENCE.exec(lines[i]);
    if (!match) continue;
    const close = closeOf(lines, i, match[2], match[1]);
    snippets.push(snippetAt(lines, i, close, match, doc));
    i = close;
  }
  return snippets;
}

/** Convention problems: an opt-out without a reason, two snippets writing one file. */
export function conventionProblems(snippets) {
  const problems = [];
  const files = new Map();
  for (const snippet of snippets) {
    const at = `${snippet.doc}:${String(snippet.line - 1)}`;
    if (snippet.noCheck === "")
      problems.push(`${at}: \`no-check\` needs a reason (no-check: <why>)`);
    if (snippet.file === undefined) continue;
    const first = files.get(snippet.file);
    if (first) problems.push(`${at}: file=${snippet.file} is already written at ${first}`);
    else files.set(snippet.file, at);
  }
  return problems;
}

/** The text written for a snippet, and how many hidden lines come before its first line. */
export function sourceOf(snippet) {
  const text = [...snippet.before, ...snippet.code, ...snippet.after].join("\n");
  return { text: `${text}\n`, offset: snippet.before.length };
}
