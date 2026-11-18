import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

/**
 * A server has ONE `failCommand` fail point: a file that sets its own replaces another file's, and
 * its `off` switches the other's off. The test files run in parallel workers, so every file that
 * sets a fail point holds this lock for the whole file (a directory per server, made atomically).
 * Call it first in the file, before its other hooks: the lock is taken first and given back last.
 */
const WAIT_MS = 20 * 60_000;
/** A lock older than this was left by a worker that died. */
const STALE_MS = 15 * 60_000;

const lockPath = (): string =>
  join(
    tmpdir(),
    `agboss-mongodb-failpoint-${createHash("sha256")
      .update(process.env.AGBOSS_MONGODB_TEST_URL ?? "")
      .digest("hex")
      .slice(0, 12)}.lock`,
  );

async function isStale(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

async function acquire(path: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      await mkdir(path);
      return;
    } catch {
      if (await isStale(path)) await rm(path, { recursive: true, force: true });
      else if (Date.now() > deadline) throw new Error("the fail point lock was not released");
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

export function holdFailPoints(): void {
  const path = lockPath();
  beforeAll(() => acquire(path), WAIT_MS + 5_000);
  afterAll(() => rm(path, { recursive: true, force: true }));
}
