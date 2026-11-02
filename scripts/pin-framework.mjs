#!/usr/bin/env node
/**
 * Writes the pin `.agboss-version.json` (agbossjs/agboss#691): which `@agboss/core` this package is
 * built and tested against.
 *   node scripts/pin-framework.mjs --sha <agboss main sha> [--version <x.y.z>]
 *     a commit of agbossjs/agboss, packed by `npm run pack:framework` (`source: "commit"`) — the
 *     pin between releases;
 *   node scripts/pin-framework.mjs --registry <x.y.z>
 *     the published `@agboss/core@<x.y.z>` and `@agboss/cli@<x.y.z>`, downloaded by
 *     `npm run pack:framework` (`source: "registry"`, their integrity checked against the
 *     registry's) — the pin of a release: the release workflow publishes only on it. Its
 *     `frameworkSha` is the commit npm recorded (`gitHead`), when it has one.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PIN = join(ROOT, ".agboss-version.json");
const SHA = /^[0-9a-f]{40}$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;

/** The pin a command line asks for, over the current one. */
export function pinOf(current, args, gitHeadOf) {
  const valueOf = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const sha = valueOf("--sha");
  const registry = valueOf("--registry");
  if ((sha === undefined) === (registry === undefined))
    throw new Error("give one of --sha <commit> or --registry <x.y.z>");
  if (sha !== undefined) {
    if (!SHA.test(sha)) throw new Error(`--sha must be a full commit SHA, got ${sha}`);
    const version = valueOf("--version") ?? current.version;
    if (!VERSION.test(version)) throw new Error(`--version must be x.y.z, got ${String(version)}`);
    return { ...current, source: "commit", frameworkSha: sha, version };
  }
  if (!VERSION.test(registry)) throw new Error(`--registry must be x.y.z, got ${registry}`);
  const gitHead = gitHeadOf(registry);
  return {
    ...current,
    source: "registry",
    frameworkSha: gitHead ?? current.frameworkSha,
    version: registry,
  };
}

/** One field of `@agboss/core@<version>` on npm (`""` when it has none; a 404 throws). */
const fieldOf = (version, field) =>
  execFileSync("npm", ["view", `@agboss/core@${version}`, field], { encoding: "utf8" }).trim();

/** The commit npm recorded for `@agboss/core@<version>`; refuses a version npm does not have. */
function gitHeadOf(version) {
  if (fieldOf(version, "version") !== version)
    throw new Error(`@agboss/core@${version} is not on npm`);
  const gitHead = fieldOf(version, "gitHead");
  return SHA.test(gitHead) ? gitHead : undefined;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const pin = pinOf(JSON.parse(readFileSync(PIN, "utf8")), process.argv.slice(2), gitHeadOf);
    writeFileSync(PIN, `${JSON.stringify(pin, null, 2)}\n`);
    console.log(`[pin-framework] ${JSON.stringify(pin)}`);
  } catch (error) {
    console.error(`[pin-framework] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
