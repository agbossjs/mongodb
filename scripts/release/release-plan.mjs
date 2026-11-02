#!/usr/bin/env node
// The release plan of every package of the train after the core (#691: `@agboss/postgres`,
// `@agboss/mongodb`, `@agboss/redis`); agbossjs/postgres holds the original, keep the copies alike. What a release of the package may publish (agbossjs/agboss#691 AC2), checked
// before anything is: the tag `<name>-vX.Y.Z` (`postgres-v0.1.1` for `@agboss/postgres`) is the
// package's version; the train's order holds — the pin
// (`.agboss-version.json`) takes `@agboss/core` from the registry (`source: "registry"`), at a
// version already on npm, the one the peer dependency names (`^X.Y.Z`) — so the package was built
// and tested against the core users install, never a commit of it. A publish refuses on any
// problem; a dry run (`--dry-run`, on pull requests) prints them and stops only on those that do
// not depend on the release moment (a commit pin and an unpublished core are expected before it).
//   node scripts/release/release-plan.mjs --tag postgres-v0.1.1   # the publish job
//   node scripts/release/release-plan.mjs --dry-run              # the dry run
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^\d+\.\d+\.\d+$/u;

/** The tag prefix of a package's releases: `postgres-v` for `@agboss/postgres`. */
export function tagPrefixOf(name) {
  return `${name.replace(/^@agboss\//u, "")}-v`;
}

/** The version a tag of package `name` names, or `undefined` when it is no release tag of it. */
export function versionOfTag(tag, name) {
  const prefix = tagPrefixOf(name);
  if (!tag.startsWith(prefix)) return undefined;
  const version = tag.slice(prefix.length);
  return VERSION.test(version) ? version : undefined;
}

/**
 * Every problem of a release: `{ problem, isReleaseMoment }` — the second when it is expected
 * before the core is published (a dry run reports it and goes on). `tag` is `undefined` in a dry
 * run (the package's own version is the tag it would get).
 */
export function releaseProblemsOf({ tag, pkg, pin, publishedCoreVersions }) {
  const problems = [];
  const add = (problem, isReleaseMoment = false) => problems.push({ problem, isReleaseMoment });
  if (!VERSION.test(pkg.version)) add(`package.json version ${pkg.version} is not X.Y.Z`);
  if (tag !== undefined && versionOfTag(tag, pkg.name) !== pkg.version)
    add(`the tag ${tag} is not ${tagPrefixOf(pkg.name)}${pkg.version}, the package's version`);
  const peer = pkg.peerDependencies?.["@agboss/core"];
  if (peer !== `^${pin.version}`)
    add(`the peer dependency @agboss/core is ${String(peer)}, not ^${pin.version} (the pin)`, true);
  if (pin.source !== "registry")
    add(
      `.agboss-version.json takes @agboss/core from ${pin.source ?? "a commit"}: pin the published core first (node scripts/pin-framework.mjs --registry ${pkg.version})`,
      true,
    );
  if (!publishedCoreVersions.includes(pin.version))
    add(`@agboss/core@${pin.version} is not on npm: publish the core first`, true);
  return problems;
}

/** The problems that stop this run: all of them for a publish, only the timeless ones for a dry run. */
export function blockingProblemsOf(problems, { isDryRun }) {
  return isDryRun ? problems.filter((found) => !found.isReleaseMoment) : problems;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (file) => JSON.parse(readFileSync(join(ROOT, file), "utf8"));

/** The versions of `@agboss/core` on npm (none when the registry does not know it). */
function publishedCoreVersions() {
  try {
    const out = execFileSync("npm", ["view", "@agboss/core", "versions", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const versions = JSON.parse(out);
    return Array.isArray(versions) ? versions : [versions];
  } catch {
    return [];
  }
}

function main(args) {
  const isDryRun = args.includes("--dry-run");
  const at = args.indexOf("--tag");
  const tag = at === -1 ? undefined : args[at + 1];
  if (!isDryRun && tag === undefined) throw new Error("--tag <name>-vX.Y.Z or --dry-run");
  const pkg = readJson("package.json");
  const pin = readJson(".agboss-version.json");
  const problems = releaseProblemsOf({
    tag,
    pkg,
    pin,
    publishedCoreVersions: publishedCoreVersions(),
  });
  for (const { problem, isReleaseMoment } of problems)
    console.log(
      `[release-plan] ${isDryRun && isReleaseMoment ? "at release:" : "problem:"} ${problem}`,
    );
  const blocking = blockingProblemsOf(problems, { isDryRun });
  if (blocking.length > 0) return 1;
  console.log(
    `[release-plan] ${pkg.name}@${pkg.version} (${tagPrefixOf(pkg.name)}${pkg.version}) on @agboss/core@${pin.version}: ${isDryRun ? "the dry run goes on" : "ready to publish"}`,
  );
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`[release-plan] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
