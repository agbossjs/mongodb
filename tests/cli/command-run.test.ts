/**
 * agbossjs/mongodb#99: what `agboss-mongodb migrate` prints and passes on, in this process (the
 * bin's own test runs it in another, which a mutant of the shard never reaches): the lines of a
 * real run on a real server, the options it hands `migrateMongodb`, the usage errors told exactly.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as migrate from "../../src/connection/migrate.js";
import { ExitCode, runCommand, USAGE, type CommandIo } from "../../src/cli.js";
import { dropDatabase } from "../support/database.js";
import { freshDatabaseName, REPLICA_SET_URL } from "../support/server.js";

/** A command's io: the environment given, its lines kept. */
function ioOf(
  env: CommandIo["env"] = {},
): CommandIo & { readonly lines: string[]; readonly errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { env, lines, errors, out: (line) => lines.push(line), err: (line) => errors.push(line) };
}

const database = freshDatabaseName();

afterAll(() => dropDatabase(database));
afterEach(() => vi.restoreAllMocks());

describe("agbossjs/mongodb#99: a run that reaches the server prints what it did", () => {
  it("one line for every migration applied, then one that nothing is left", async () => {
    const env = { MONGODB_URL: REPLICA_SET_URL };
    const first = ioOf(env);
    const second = ioOf(env);

    const firstCode = await runCommand(["migrate", "--database", database], first);
    const secondCode = await runCommand(["migrate", "--database", database], second);

    expect(firstCode).toBe(ExitCode.Ok);
    expect(first.errors).toEqual([]);
    expect(first.lines.length).toBeGreaterThanOrEqual(4);
    expect(first.lines[0]).toBe(`applied 0001_stores (${database})`);
    first.lines.forEach((line, index) => {
      expect(line).toMatch(
        new RegExp(
          `^applied ${String(index + 1).padStart(4, "0")}_[\\w-]+ \\(${database}\\)$`,
          "u",
        ),
      );
    });
    expect(secondCode).toBe(ExitCode.Ok);
    expect(second.errors).toEqual([]);
    expect(second.lines).toEqual([
      `nothing to apply: ${database} is at version ${String(first.lines.length)}`,
    ]);
  });
});

describe("agbossjs/mongodb#99: the options the command hands the migration", () => {
  /** The options `migrateMongodb` was called with for `args`; the run is stopped there. */
  async function optionsOf(args: string[], env: CommandIo["env"]): Promise<unknown> {
    const spy = vi.spyOn(migrate, "migrateMongodb").mockRejectedValue(new Error("stop"));
    await runCommand(args, ioOf(env));
    return spy.mock.calls[0]?.[0];
  }

  it("with no database anywhere, there is none in the options, not an undefined one", async () => {
    const options = await optionsOf(["migrate"], { MONGODB_URL: "mongodb://h/" });

    expect(options).toStrictEqual({ url: "mongodb://h/" });
  });

  it("an empty MONGODB_DATABASE is no database", async () => {
    const options = await optionsOf(["migrate"], {
      MONGODB_URL: "mongodb://h/x",
      MONGODB_DATABASE: "",
    });

    expect(options).toStrictEqual({ url: "mongodb://h/x" });
  });

  it("the database of the environment is in the options", async () => {
    const options = await optionsOf(["migrate"], {
      MONGODB_URL: "mongodb://h/x",
      MONGODB_DATABASE: "env_db",
    });

    expect(options).toStrictEqual({ url: "mongodb://h/x", database: "env_db" });
  });

  it("an empty MONGODB_URL is none: the command is a usage error", async () => {
    const io = ioOf({ MONGODB_URL: "" });

    expect(await runCommand(["migrate"], io)).toBe(ExitCode.Usage);
    expect(io.errors).toEqual([`agboss-mongodb: no --url and no MONGODB_URL\n${USAGE}`]);
  });
});

describe("agbossjs/mongodb#99: the usage errors are told exactly", () => {
  it.each([
    [["-h"], "-h"],
    [["--help"], "--help"],
  ])("%j prints the usage and no error, exit 0", async (args) => {
    const io = ioOf();

    expect(await runCommand(args, io)).toBe(ExitCode.Ok);
    expect(io.lines).toEqual([USAGE]);
    expect(io.errors).toEqual([]);
  });

  it.each([
    [["migrate", "stray"], "none"],
    [["migrate", "--url", "mongodb://h/", "stray"], "--url"],
    [["migrate", "--schema", "s", "--other"], "<flag> <flag>"],
    [["migrate", "--url=a", "--url=b"], "--url --url"],
    [["migrate", "--database=x", "--bogus=secret"], "--database <flag>"],
    [
      ["migrate", "--allow-live-leases", "--allow-live-leases"],
      "--allow-live-leases --allow-live-leases",
    ],
    [["migrate", "--allow-live-leases=yes"], "--allow-live-leases"],
    [["migrate", "--url", "mongodb://h/", "--url"], "--url --url"],
  ])("%j names the flags it saw: %s", async (args, flags) => {
    const io = ioOf({ MONGODB_URL: "mongodb://h/" });

    expect(await runCommand(args, io)).toBe(ExitCode.Usage);
    expect(io.errors).toEqual([`agboss-mongodb: unexpected arguments (flags: ${flags})\n${USAGE}`]);
  });
});
