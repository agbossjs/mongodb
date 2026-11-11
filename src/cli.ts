import { withoutPasswords } from "./redaction.js";
import {
  migrateMongodb,
  type MigrateMongodbOptions,
  type MongoMigrationReport,
} from "./connection/migrate.js";

/**
 * `agboss-mongodb` — the package's command (agbossjs/agboss#891): `migrate [--database <name>]` on
 * `MONGODB_URL` (`--url` too, which shows the URL's credentials in the process list) makes the stores' collections and indexes and writes
 * the schema's version; a second run applies nothing. Usable as a Kubernetes Job: exit code 0 when
 * the schema is current, 1 when the run failed, 2 for a wrong command line.
 */

/** Where the command reads its environment and writes its lines. */
export interface CommandIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** How the command ended. */
export enum ExitCode {
  Ok = 0,
  Failed = 1,
  Usage = 2,
}

export const USAGE = `usage: agboss-mongodb migrate [--database <name>] [--url <mongodb-url>]
  Migrates the @agboss/mongodb schema on MONGODB_URL (the database: --database, else the URL's, else
  agboss). Prefer MONGODB_URL: --url puts the URL, its credentials too, in the process list.`;

const FLAGS = new Set(["--url", "--database"]);

/**
 * The flags of a command line as a usage error names them — allowlisted: a known flag by its name
 * (`--url=…` cut at `=`), any other `<flag>`, a value never — so no URL or password (`-psecret`,
 * `--x=secret`) reaches the output.
 */
const flagNamesOf = (rest: readonly string[]): string =>
  rest
    .filter((argument) => argument.startsWith("-"))
    .map((argument) => argument.split("=", 1)[0] ?? "")
    .map((name) => (FLAGS.has(name) ? name : "<flag>"))
    .join(" ");

/** The flags of `migrate`'s arguments, each once with a value; a string → a usage problem. */
function flagsOf(rest: readonly string[]): ReadonlyMap<string, string> | string {
  const flags = new Map<string, string>();
  for (let at = 0; at < rest.length; at += 2) {
    const [flag, value] = [rest[at], rest[at + 1]];
    if (
      flag === undefined ||
      !FLAGS.has(flag) ||
      flags.has(flag) ||
      value === undefined ||
      value === ""
    )
      return `unexpected arguments (flags: ${flagNamesOf(rest) || "none"})`;
    flags.set(flag, value);
  }
  return flags;
}

/** The options of `migrate`'s arguments; a string → a usage problem. */
function optionsOf(args: readonly string[], env: CommandIo["env"]): MigrateMongodbOptions | string {
  const flags = flagsOf(args.slice(1));
  if (typeof flags === "string") return flags;
  const url = flags.get("--url") ?? env.MONGODB_URL;
  if (url === undefined || url === "") return "no --url and no MONGODB_URL";
  const database = flags.get("--database");
  return database === undefined ? { url } : { url, database };
}

/** The lines a run prints: what it applied, or that nothing was left. */
function reportLines(report: MongoMigrationReport): readonly string[] {
  const lines = report.applied.map(
    (migration) =>
      `applied ${String(migration.version).padStart(4, "0")}_${migration.name} (${report.database})`,
  );
  if (lines.length === 0)
    lines.push(`nothing to apply: ${report.database} is at version ${String(report.version)}`);
  return lines;
}

/** Runs the command line `args` (without the program name); its exit code. */
export async function runCommand(args: readonly string[], io: CommandIo): Promise<ExitCode> {
  if (args[0] === "--help" || args[0] === "-h") {
    io.out(USAGE);
    return ExitCode.Ok;
  }
  const options =
    args[0] === "migrate" ? optionsOf(args, io.env) : "unknown command (the commands: migrate)";
  if (typeof options === "string") {
    io.err(withoutPasswords(`agboss-mongodb: ${options}\n${USAGE}`));
    return ExitCode.Usage;
  }
  try {
    for (const line of reportLines(await migrateMongodb(options))) io.out(line);
    return ExitCode.Ok;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    io.err(withoutPasswords(`agboss-mongodb: the migration failed — ${reason}`));
    return ExitCode.Failed;
  }
}
