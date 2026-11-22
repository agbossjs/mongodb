/**
 * agbossjs/mongodb#103: a mutation run shortens the servers' transaction lifetime (`scripts/transaction-lifetime.mjs`) and
 * puts it back when it ends, whatever its outcome: the parameter is server-wide, so a run that left 10 s behind changed
 * every later `npm run check` of the same servers. The tests use 55 s, which no other test file can notice while it lasts.
 */
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withTransactionLifetime } from "../../scripts/transaction-lifetime.mjs";
import { REPLICA_SET_URL } from "../support/server.js";
import { runProcess } from "../support/process.js";

const PARAMETER = "transactionLifetimeLimitSeconds";
const repo = new URL("../../", import.meta.url).pathname;

/** The lifetime of every member of the replica set, by host. */
async function lifetimes(): Promise<Record<string, unknown>> {
  const seeds = new MongoClient(REPLICA_SET_URL);
  try {
    const hello = (await seeds.db("admin").command({ hello: 1 })) as { hosts: string[] };
    const found: Record<string, unknown> = {};
    for (const host of hello.hosts) {
      const member = new MongoClient(`mongodb://${host}/?directConnection=true`);
      try {
        const got = (await member
          .db("admin")
          .command({ getParameter: 1, [PARAMETER]: 1 })) as Record<string, unknown>;
        found[host] = got[PARAMETER];
      } finally {
        await member.close();
      }
    }
    return found;
  } finally {
    await seeds.close();
  }
}

let before: Record<string, unknown> = {};
beforeEach(async () => {
  before = await lifetimes();
});
afterEach(async () => {
  // whatever a failing test left: the first value of the first member, for all (the members start equal)
  const [first] = Object.values(before);
  if (typeof first === "number")
    await withTransactionLifetime(REPLICA_SET_URL, first, () => Promise.resolve());
});

describe("withTransactionLifetime", () => {
  it("sets every member's lifetime for the run and puts each back after it", async () => {
    const during = await withTransactionLifetime(REPLICA_SET_URL, 55, lifetimes);

    expect(Object.values(during).every((seconds) => seconds === 55)).toBe(true);
    expect(Object.keys(during).length).toBeGreaterThan(0);
    expect(await lifetimes()).toEqual(before);
  });

  it("puts back a value that is not the default, and returns the run's result", async () => {
    await withTransactionLifetime(REPLICA_SET_URL, 45, async () => {
      const before45 = await lifetimes();
      const result = await withTransactionLifetime(REPLICA_SET_URL, 55, () =>
        Promise.resolve("done"),
      );

      expect(result).toBe("done");
      expect(await lifetimes()).toEqual(before45);
    });
  });

  it("puts it back when the run throws, and throws the run's error", async () => {
    await expect(
      withTransactionLifetime(REPLICA_SET_URL, 55, () =>
        Promise.reject(new Error("the run failed")),
      ),
    ).rejects.toThrow("the run failed");

    expect(await lifetimes()).toEqual(before);
  });

  it("scripts/mutation-run.mjs passes Stryker's exit code and output, and puts the lifetime back: success and failure", async () => {
    const script = join(repo, "scripts/mutation-run.mjs");

    const version = await runProcess("node", [script, "--version"], { cwd: repo });
    const unknown = await runProcess("node", [script, "no-such-command"], { cwd: repo });

    expect(version.status).toBe(0);
    expect(version.stdout).toMatch(/\d+\.\d+\.\d+/);
    expect(unknown.status).not.toBe(0);
    expect(await lifetimes()).toEqual(before);
  });

  it("scripts/mutation-run.mjs without a replica set URL fails before it runs anything", async () => {
    const run = await runProcess("node", [join(repo, "scripts/mutation-run.mjs"), "--version"], {
      cwd: repo,
      env: { ...process.env, AGBOSS_MONGODB_TEST_URL: "" },
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("AGBOSS_MONGODB_TEST_URL is not set");
  });
});
