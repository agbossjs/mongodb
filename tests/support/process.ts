/**
 * A child process a test runs, awaited (a copy of agbossjs/agboss packages/agboss/tests/helpers/
 * process.ts, agbossjs/agboss#630) — never `spawnSync` / `execFileSync` / `execSync` (ESLint forbids
 * them in the tests). A synchronous one holds the vitest fork's event loop: held 60 s, the fork's
 * pending report to vitest (birpc's `onTaskUpdate`) times out and the fork's run rejects.
 */
import { spawn } from "node:child_process";

/** What a finished child process left: its exit code (`null` when a signal ended it) and output. */
export interface ProcessRun {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, then closed. */
  readonly input?: string;
}

/** Runs `command` with `args` to its end; a child that cannot start (ENOENT, …) rejects. */
export function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}

/** `runProcess`, its stdout — and a failure, naming the command and its stderr, unless it exits 0. */
export async function outputOf(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<string> {
  const run = await runProcess(command, args, options);
  if (run.status !== 0) {
    const ended = run.signal ?? `exit ${String(run.status)}`;
    throw new Error(`${command} ${args.join(" ")} failed (${ended}):\n${run.stderr}`);
  }
  return run.stdout;
}

/** `node <args…>` with this process's own Node. */
export const runNode = (
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessRun> => runProcess(process.execPath, args, options);
