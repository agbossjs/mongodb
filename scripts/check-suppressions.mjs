#!/usr/bin/env node
/**
 * The core's suppression ratchet (agbossjs/agboss scripts/check-suppressions.mjs) with a budget of
 * zero: any `eslint-disable`, `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error`, `as any` or
 * `as unknown as` in `src/`, `tests/` or the scripts fails the check — fix the code instead.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["src", "tests", "scripts"];
const ESCAPES = [
  [/eslint-disable/, "eslint-disable"],
  [/@ts-(ignore|nocheck|expect-error)/, "@ts-ignore"],
  [/\bas any\b/, "as any"],
  [/\bas unknown as\b/, "as unknown as"],
];
const SELF = fileURLToPath(import.meta.url);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(ts|mts|js|mjs)$/.test(name) && path !== SELF) yield path;
  }
}

const found = [];
for (const dir of DIRS) {
  for (const path of files(join(ROOT, dir))) {
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, index) => {
        for (const [pattern, kind] of ESCAPES)
          if (pattern.test(line)) found.push(`${relative(ROOT, path)}:${index + 1} ${kind}`);
      });
  }
}

if (found.length > 0) {
  console.error(`suppressions are not allowed (budget 0):\n  ${found.join("\n  ")}`);
  process.exit(1);
}
console.log("check:suppressions — none");
