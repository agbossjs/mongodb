import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll } from "vitest";
import { acquireLock, releaseLock, WAIT_MS } from "./dir-lock.js";

/**
 * A server has ONE `failCommand` fail point: a file that sets its own replaces another file's, and
 * its `off` switches the other's off. The test files run in parallel workers, so every file that
 * sets a fail point holds this lock for the whole file (a directory per server, made atomically).
 * Call it first in the file, before its other hooks: the lock is taken first and given back last.
 * The lock itself, and how it is taken and removed by workers that can be killed, is `dir-lock.ts`.
 */
const lockPath = (): string =>
  join(
    tmpdir(),
    `agboss-mongodb-failpoint-${createHash("sha256")
      .update(process.env.AGBOSS_MONGODB_TEST_URL ?? "")
      .digest("hex")
      .slice(0, 12)}.lock`,
  );

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
  let held: string | undefined;
  beforeAll(async () => {
    held = await acquireLock(path);
    await switchOffLeftover();
  }, WAIT_MS + 5_000);
  afterAll(async () => {
    if (held !== undefined) await releaseLock(path, held);
  });
}
