#!/usr/bin/env node
// A copy of agbossjs/agboss scripts/release/ci-gate.mjs (#691): keep the two alike.
// The release workflow publishes only a commit whose full CI passed (agbossjs/agboss#691 AC1, AC2):
// the `CI` workflow's run for a push of exactly that commit to `main`, every job of it green. It
// asks GitHub for the workflow's runs on the commit and waits while one is queued or running (the
// tag may be pushed before main's CI ends); a failed or cancelled run, or none after the wait,
// stops the release. `node scripts/release/ci-gate.mjs --sha <sha> [--workflow ci.yml]
// [--timeout-minutes 150]` with `GITHUB_TOKEN` (or `GH_TOKEN`) and `GITHUB_REPOSITORY` set.
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** What the runs of one commit say: `passed`, `pending` (wait), `failed` or `missing`. */
export const CiVerdict = Object.freeze({
  Passed: "passed",
  Pending: "pending",
  Failed: "failed",
  Missing: "missing",
});

/**
 * The verdict of the workflow runs GitHub lists for `sha`: only runs of a `push` (a merge to
 * `main`) on exactly that commit count — a pull request's run tested a merge commit, a scheduled
 * run another moment. One successful run passes; else one still queued or running is pending;
 * else a completed one that did not succeed fails; no run at all is missing.
 */
export function ciVerdictOf(runs, sha) {
  const own = runs.filter((run) => run.head_sha === sha && run.event === "push");
  if (own.some((run) => run.status === "completed" && run.conclusion === "success"))
    return CiVerdict.Passed;
  if (own.some((run) => run.status !== "completed")) return CiVerdict.Pending;
  return own.length > 0 ? CiVerdict.Failed : CiVerdict.Missing;
}

/** The options of the command line: `--sha`, `--workflow`, `--timeout-minutes`. */
export function ciGateOptionsOf(args) {
  const valueOf = (name, fallback) => {
    const at = args.indexOf(name);
    return at === -1 ? fallback : args[at + 1];
  };
  const sha = valueOf("--sha");
  if (sha === undefined || !/^[0-9a-f]{40}$/u.test(sha))
    throw new Error(`--sha must be a full commit SHA, got ${String(sha)}`);
  const minutes = Number(valueOf("--timeout-minutes", "150"));
  if (!Number.isInteger(minutes) || minutes < 0)
    throw new Error("--timeout-minutes must be a whole number of minutes");
  return { sha, workflow: valueOf("--workflow", "ci.yml"), timeoutMinutes: minutes };
}

async function runsOf({ repository, token, workflow, sha }) {
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=100`;
  const response = await globalThis.fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub answered ${String(response.status)} for ${url}`);
  const body = await response.json();
  return body.workflow_runs ?? [];
}

async function main(args, env) {
  const options = ciGateOptionsOf(args);
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (repository === undefined || token === undefined)
    throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN (or GH_TOKEN) must be set");
  const deadline = Date.now() + options.timeoutMinutes * 60_000;
  for (;;) {
    const verdict = ciVerdictOf(await runsOf({ repository, token, ...options }), options.sha);
    console.log(`[ci-gate] ${options.workflow} on ${options.sha}: ${verdict}`);
    if (verdict === CiVerdict.Passed) return 0;
    if (verdict === CiVerdict.Failed) return 1;
    if (Date.now() >= deadline) {
      console.error(
        `[ci-gate] no successful ${options.workflow} run after ${String(options.timeoutMinutes)} min`,
      );
      return 1;
    }
    await pause(30_000);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`[ci-gate] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
