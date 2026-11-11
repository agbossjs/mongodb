#!/usr/bin/env node
// `agboss-mongodb migrate --url <url> [--database <name>]`: the schema of @agboss/mongodb (src/cli.ts).
import { runCommand } from "../dist/cli.js";

const code = await runCommand(process.argv.slice(2), {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
process.exitCode = code;
