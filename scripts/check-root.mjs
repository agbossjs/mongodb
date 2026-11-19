#!/usr/bin/env node
// Root allowlist (agbossjs/agboss#180; a copy of its scripts/check-root.mjs, agbossjs/agboss#1213):
// every tracked top-level entry must be listed in `.root-allowlist`.
// Stray scripts, logs and ad-hoc notes at the root become precedent for the next agent.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const allowed = new Set(
  readFileSync(new URL("../.root-allowlist", import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean),
);
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .map((path) => path.split("/")[0]);
const stray = [...new Set(tracked)].filter((entry) => !allowed.has(entry)).sort();
if (stray.length) {
  console.error(
    `Not allowed at the repo root (add to .root-allowlist only if it belongs there):\n  ${stray.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(`repo root clean (${allowed.size} allowed entries)`);
