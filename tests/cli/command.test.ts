import { describe, expect, it } from "vitest";
import { ExitCode, runCommand, USAGE, type CommandIo } from "../../src/cli.js";
import { MIGRATE_COMMAND } from "../../src/errors.js";

/** A command's io: the environment given, its lines kept. */
function ioOf(
  env: CommandIo["env"] = {},
): CommandIo & { readonly lines: string[]; readonly errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { env, lines, errors, out: (line) => lines.push(line), err: (line) => errors.push(line) };
}

describe("agbossjs/agboss#891: agboss-mongodb's command line", () => {
  it("--help prints the usage, exit 0", async () => {
    const io = ioOf();

    expect(await runCommand(["--help"], io)).toBe(ExitCode.Ok);
    expect(io.lines).toEqual([USAGE]);
  });

  it.each([
    [["migrate"], "no --url and no MONGODB_URL"],
    [["migrate", "--url"], "unexpected arguments (flags: --url)"],
    [["migrate", "--url", "mongodb://h/", "--url", "mongodb://x/"], "unexpected arguments"],
    [["migrate", "--schema", "s"], "unexpected arguments (flags: <flag>)"],
    [["migrate", "--database", ""], "unexpected arguments"],
    [["drop"], "unknown command (the commands: migrate)"],
  ])("%j is a usage error, exit 2: %s", async (args, problem) => {
    const io = ioOf();

    expect(await runCommand(args, io)).toBe(ExitCode.Usage);
    expect(io.errors[0]).toContain(`agboss-mongodb: ${problem}`);
    expect(io.errors[0]).toContain(USAGE);
  });

  it("a URL the driver cannot parse fails the run, exit 1, the URL never printed", async () => {
    const io = ioOf({ MONGODB_URL: "mongodb://app:hunter2@/x" });

    expect(await runCommand(["migrate"], io)).toBe(ExitCode.Failed);
    expect(io.errors[0]).toMatch(/^agboss-mongodb: the migration failed — /);
    expect(io.errors[0]).not.toContain("hunter2");
  });

  it("the URL comes from MONGODB_URL without --url, and no line of a failed run prints its password", async () => {
    const url = "mongodb://app:s3cr3t-pw@127.0.0.1:1/?replicaSet=rs0&serverSelectionTimeoutMS=200";
    const io = ioOf({ MONGODB_URL: url });

    expect(await runCommand(["migrate", "--database", "desk"], io)).toBe(ExitCode.Failed);
    expect(io.errors[0]).toMatch(/^agboss-mongodb: the migration failed — /);
    expect([...io.lines, ...io.errors].join("\n")).not.toContain("s3cr3t-pw");
  });

  it("the remedy an error names reads the URL from the environment, never from the command line", () => {
    expect(MIGRATE_COMMAND).toBe("npx agboss-mongodb migrate");
    expect(USAGE).toContain("Prefer MONGODB_URL");
  });

  it.each([
    [["migrate", "--x=mongodb://u:secret@h/"]],
    [["migrate", "--url", "mongodb://u:secret@h/", "--url", "mongodb://u:secret@h/"]],
    [["migrate", "--url", "mongodb://u:secret@h/", "extra"]],
    [["migrate", "mongodb://u:secret@h/"]],
    [["mongodb://u:secret@h/"]],
    [["postgres://u:secret@h"]],
    [["mongodb+srv://u:secret@h"]],
    [["--x=secret"]],
    [["-psecret"]],
    [["secret"]],
    [["migrate", "postgres://u:secret@h"]],
    [["migrate", "mongodb+srv://u:secret@h"]],
    [["migrate", "--x=secret"]],
    [["migrate", "-psecret"]],
  ])("a usage error never prints a URL's password: %j", async (args) => {
    const io = ioOf();

    expect(await runCommand(args, io)).toBe(ExitCode.Usage);
    expect([...io.lines, ...io.errors].join("\n")).not.toContain("secret");
  });
});
