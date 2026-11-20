import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll } from "vitest";

/**
 * A server has ONE `failCommand` fail point: a file that sets its own replaces another file's, and
 * its `off` switches the other's off. The test files run in parallel workers, so every file that
 * sets a fail point holds this lock for the whole file (a directory per server, made atomically).
 * Call it first in the file, before its other hooks: the lock is taken first and given back last.
 */
const WAIT_MS = 20 * 60_000;
/** A lock older than this was left by a worker that hung (its owner is alive and holds it). */
const STALE_MS = 15 * 60_000;
/** The time a taker has to write its pid into the directory it just made. */
const OWNERLESS_MS = 10_000;

const lockPath = (): string =>
  join(
    tmpdir(),
    `agboss-mongodb-failpoint-${createHash("sha256")
      .update(process.env.AGBOSS_MONGODB_TEST_URL ?? "")
      .digest("hex")
      .slice(0, 12)}.lock`,
  );

/** Whether the process `pid` is alive on this machine. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it is there, another user's
    return (error as { code?: string }).code === "EPERM";
  }
}

/**
 * Whether the lock was left by a worker that is gone (agbossjs/agboss#91): Stryker kills a test
 * runner that has run out its time without running its `afterAll`, and every other runner of the
 * shard then waited out `STALE_MS` behind its lock — a run that looked hung for an hour and read
 * as timeouts. The owner's pid is in the directory: a dead one frees the lock at once.
 */
async function isStale(path: string): Promise<boolean> {
  try {
    const age = Date.now() - (await stat(path)).mtimeMs;
    const owner = Number(await readFile(join(path, "owner"), "utf8").catch(() => ""));
    if (Number.isInteger(owner) && owner > 0) return !isAlive(owner) || age > STALE_MS;
    return age > OWNERLESS_MS;
  } catch {
    return false;
  }
}

async function acquire(path: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      await mkdir(path);
      await writeFile(join(path, "owner"), String(process.pid));
      return;
    } catch {
      if (await isStale(path)) await rm(path, { recursive: true, force: true });
      else if (Date.now() > deadline) throw new Error("the fail point lock was not released");
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * Switches the server's fail point off: one set by a worker that was killed (Stryker does, on a
 * mutant that ran out its time) is still on, and every test after it fails or waits for nothing
 * (a `killCursors` that is refused for ever leaves a cursor on the server: agbossjs/agboss#91).
 */
async function switchOffLeftover(): Promise<void> {
  const client = new MongoClient(process.env.AGBOSS_MONGODB_TEST_URL ?? "");
  try {
    await client.db("admin").command({ configureFailPoint: "failCommand", mode: "off" });
  } finally {
    await client.close();
  }
}

export function holdFailPoints(): void {
  const path = lockPath();
  beforeAll(async () => {
    await acquire(path);
    await switchOffLeftover();
  }, WAIT_MS + 5_000);
  afterAll(() => rm(path, { recursive: true, force: true }));
}
