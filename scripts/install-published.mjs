#!/usr/bin/env node
/**
 * Once `@agboss/core` is on the registry: installs the published version the peer dependency
 * names (`--version <x.y.z>`, default the lowest of the range) and `@agboss/cli` of the same
 * version (a dev tool, as in agbossjs/postgres) instead of the packed tarballs, without changing
 * `package.json` or the lockfile (devDependencies for the install only). The tree resolves its
 * ranges to releases at least three days old (agbossjs/agboss#523: `--before`) — the version just
 * published included, so right after a release the maintainer sets `AGBOSS_NPM_BEFORE` (an ISO
 * date, locally; agbossjs/agboss RELEASE_CHECKLIST.md → Dependency installs).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rangeInstallArguments } from "./npm-before.mjs";

/** The install's arguments: no lockfile written, no release younger than the minimum age. */
export const publishedInstallArguments = (env = process.env, now = new Date()) =>
  rangeInstallArguments(["--no-package-lock", "--no-audit", "--no-fund"], env, now);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = join(ROOT, "package.json");

/** Installs `@agboss/core` and `@agboss/cli` of `--version` (default the peer range's lowest). */
function installPublished(args) {
  const original = readFileSync(PACKAGE, "utf8");
  const pkg = JSON.parse(original);
  const at = args.indexOf("--version");
  const version =
    at === -1 ? pkg.peerDependencies["@agboss/core"].replace(/^[\^~]/, "") : args[at + 1];

  try {
    const withPublished = {
      ...pkg,
      devDependencies: { ...pkg.devDependencies, "@agboss/core": version, "@agboss/cli": version },
    };
    writeFileSync(PACKAGE, `${JSON.stringify(withPublished, null, 2)}\n`);
    execFileSync("npm", publishedInstallArguments(), { cwd: ROOT, stdio: "inherit" });
  } finally {
    writeFileSync(PACKAGE, original);
  }
  console.log(
    `[install-published] @agboss/core@${version} and @agboss/cli@${version} from the registry`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  installPublished(process.argv.slice(2));
