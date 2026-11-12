import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { dropDatabase } from "../support/database.js";
import { freshDatabaseName, REPLICA_SET_URL } from "../support/server.js";

const run = promisify(execFile);
const BIN = new URL("../../bin/agboss-mongodb.js", import.meta.url).pathname;
const BUILT = new URL("../../dist/cli.js", import.meta.url).pathname;

const database = freshDatabaseName();
const [fromEnv, fromFlag] = [freshDatabaseName(), freshDatabaseName()];

afterAll(async () => {
  for (const name of [database, fromEnv, fromFlag]) await dropDatabase(name);
});

describe("agbossjs/agboss#891 AC1: the agboss-mongodb bin (a Kubernetes Job)", () => {
  it("is built: npm test builds first (pretest)", () => {
    expect(existsSync(BUILT)).toBe(true);
  });

  it("AC1: migrates, then reports nothing to apply; a usage error exits 2", async () => {
    const first = await run("node", [
      BIN,
      "migrate",
      "--url",
      REPLICA_SET_URL,
      "--database",
      database,
    ]);
    const second = await run("node", [BIN, "migrate", "--database", database], {
      env: { ...process.env, MONGODB_URL: REPLICA_SET_URL },
    });
    const usage = await run("node", [BIN, "migrate", "--url"]).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(first.stdout).toBe(`applied 0001_stores (${database})\n`);
    expect(second.stdout).toBe(`nothing to apply: ${database} is at version 1\n`);
    expect(usage).toMatchObject({
      code: 2,
      stderr: expect.stringContaining("usage: agboss-mongodb"),
    });
  });

  it("agbossjs/agboss#891 D2: the database is --database (also --database=name), else MONGODB_DATABASE", async () => {
    const env = { ...process.env, MONGODB_URL: REPLICA_SET_URL, MONGODB_DATABASE: fromEnv };

    const byEnv = await run("node", [BIN, "migrate"], { env });
    const byEnvAgain = await run("node", [BIN, "migrate"], { env });
    const byFlag = await run("node", [BIN, "migrate", `--database=${fromFlag}`], { env });

    expect(byEnv.stdout).toBe(`applied 0001_stores (${fromEnv})\n`);
    expect(byEnvAgain.stdout).toBe(`nothing to apply: ${fromEnv} is at version 1\n`);
    expect(byFlag.stdout).toBe(`applied 0001_stores (${fromFlag})\n`);
  });
});
