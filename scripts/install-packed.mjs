#!/usr/bin/env node
/**
 * Installs the `@agboss/core` and `@agboss/cli` tarballs `npm run pack:framework` made
 * (`.packed/manifest.json`) without changing `package.json` or the lockfile: for the install only,
 * the tarballs are devDependencies (`--no-package-lock`), then `package.json` is restored — the
 * peer dependency stays the published range, `node_modules` holds the release candidate. Checks
 * each tarball's SHA-256 first and the installed versions after. The rest of the tree resolves its
 * ranges to releases at least three days old (agbossjs/agboss#523: `--before`, `AGBOSS_NPM_BEFORE`
 * overrides it); the tarballs, by path, are exempt.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rangeInstallArguments } from "./npm-before.mjs";

/** The install's arguments: no lockfile written, no release younger than the minimum age. */
export const packedInstallArguments = (env = process.env, now = new Date()) =>
  rangeInstallArguments(["--no-package-lock", "--no-audit", "--no-fund"], env, now);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, ".packed", "manifest.json");

/** The manifest's two packages, each tarball's SHA-256 checked. */
function packedOf() {
  if (!existsSync(MANIFEST)) {
    console.error(
      "[install-packed] .packed/manifest.json not found: run `npm run pack:framework` first",
    );
    process.exit(1);
  }
  const { package: core, cli, sourceCommit } = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (cli === undefined) {
    console.error("[install-packed] the manifest has no @agboss/cli: run `npm run pack:framework`");
    process.exit(1);
  }
  for (const packed of [core, cli]) {
    const tarball = join(ROOT, ".packed", packed.filename);
    const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    if (sha256 !== packed.sha256) {
      console.error(
        `[install-packed] ${packed.filename} changed since it was packed (sha256 ${sha256})`,
      );
      process.exit(1);
    }
  }
  return { core, cli, sourceCommit };
}

/** Installs the tarballs as devDependencies for the install only, then restores `package.json`. */
function installPacked(core, cli) {
  const PACKAGE = join(ROOT, "package.json");
  const original = readFileSync(PACKAGE, "utf8");
  const withTarball = JSON.parse(original);
  withTarball.devDependencies = {
    ...withTarball.devDependencies,
    "@agboss/core": `file:.packed/${core.filename}`,
    "@agboss/cli": `file:.packed/${cli.filename}`,
  };
  try {
    writeFileSync(PACKAGE, `${JSON.stringify(withTarball, null, 2)}\n`);
    execFileSync("npm", packedInstallArguments(), { cwd: ROOT, stdio: "inherit" });
  } finally {
    writeFileSync(PACKAGE, original);
  }
}

/** The installed versions are the packed ones. */
function checkInstalled(core, cli, sourceCommit) {
  for (const packed of [core, cli]) {
    const installed = JSON.parse(
      readFileSync(join(ROOT, "node_modules", ...packed.name.split("/"), "package.json"), "utf8"),
    );
    if (installed.version !== packed.version) {
      console.error(
        `[install-packed] ${packed.name}: installed ${installed.version}, expected ${packed.version}`,
      );
      process.exit(1);
    }
    console.log(`[install-packed] ${packed.name}@${installed.version} from ${sourceCommit}`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.env["npm_config_cache"] ??= join(ROOT, ".packed", ".npm-cache");
  const { core, cli, sourceCommit } = packedOf();
  installPacked(core, cli);
  checkInstalled(core, cli, sourceCommit);
}
