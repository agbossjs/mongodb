#!/usr/bin/env node
/**
 * Packs `@agboss/core` and `@agboss/cli` from the commit `.agboss-version.json` pins (the
 * agbossjs/agboss-examples pattern): the source is `AGBOSS_REPO_DIR` when set (its HEAD must be the
 * pinned SHA), else a checkout of the pinned SHA in `.agboss-source` (cloned on first use). The
 * CLI is a dev tool here, as in agbossjs/postgres (its `agboss check` for the process tests).
 * The tarballs, their SHA-256 and integrity go to `.packed/manifest.json`; `npm run
 * install:packed` installs them.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKED_DIR = join(ROOT, ".packed");
const NPM_CACHE = ".npm-cache";
const pin = JSON.parse(readFileSync(join(ROOT, ".agboss-version.json"), "utf8"));
// a cache of this repository's own: a shared ~/.npm with foreign-owned entries cannot fail the pack
process.env["npm_config_cache"] ??= join(PACKED_DIR, NPM_CACHE);

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

/** The framework's source at the pinned SHA: the given folder, or `.agboss-source`. */
function sourceDirectory() {
  const given = process.env["AGBOSS_REPO_DIR"];
  if (given !== undefined && given !== "") return resolve(given);
  const checkout = join(ROOT, ".agboss-source");
  if (!existsSync(join(checkout, ".git"))) {
    run(
      "git",
      ["clone", "--filter=blob:none", `https://github.com/${pin.repository}.git`, checkout],
      ROOT,
    );
  }
  run("git", ["fetch", "--quiet", "origin", pin.frameworkSha], checkout);
  run("git", ["checkout", "--quiet", "--detach", pin.frameworkSha], checkout);
  return checkout;
}

const source = sourceDirectory();
const head = run("git", ["rev-parse", "HEAD"], source).trim();
if (head !== pin.frameworkSha) {
  console.error(
    `[pack-framework] ${source} is at ${head}, but .agboss-version.json pins ${pin.frameworkSha}`,
  );
  process.exit(1);
}

console.log(`[pack-framework] building @agboss/core at ${head} (${source})`);
if (!existsSync(join(source, "node_modules", "typescript"))) {
  execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: source, stdio: "inherit" });
}
for (const workspace of ["@agboss/core", "@agboss/cli"])
  execFileSync("npm", ["run", "build", "-w", workspace], { cwd: source, stdio: "inherit" });

mkdirSync(PACKED_DIR, { recursive: true });
for (const entry of readdirSync(PACKED_DIR))
  if (entry !== NPM_CACHE) rmSync(join(PACKED_DIR, entry), { recursive: true });

/** Packs the workspace in `packages/<folder>`: what the manifest records of its tarball. */
function packOf(folder, name) {
  const packed = JSON.parse(
    run(
      "npm",
      ["pack", "--json", "--pack-destination", PACKED_DIR],
      join(source, "packages", folder),
    ),
  );
  // npm 10 prints a list, npm 11+ an object by package name
  const info = Array.isArray(packed) ? packed[0] : (packed[name] ?? packed);
  const tarball = join(PACKED_DIR, info.filename);
  console.log(`[pack-framework] packed ${info.name}@${info.version} -> .packed/${info.filename}`);
  return {
    name: info.name,
    version: info.version,
    filename: info.filename,
    sha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"),
    integrity: info.integrity,
  };
}

const manifest = {
  packedAt: new Date().toISOString(),
  sourceCommit: head,
  package: packOf("agboss", "@agboss/core"),
  cli: packOf("agboss-cli", "@agboss/cli"),
};
writeFileSync(join(PACKED_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
