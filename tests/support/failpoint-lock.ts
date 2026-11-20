import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

/** What a lock's `owner` file says: who holds it, since when, and a token no other holder has. */
interface Owner {
  readonly raw: string;
  readonly pid: number;
  readonly since: number;
}

/** The holder written in the lock `path`; `undefined` when there is no lock, or none that reads. */
async function ownerOf(path: string): Promise<Owner | undefined> {
  const raw = await readFile(join(path, "owner"), "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  const [pid, since] = raw.split(" ").map(Number);
  return Number.isInteger(pid) && pid !== undefined && pid > 0 && since !== undefined
    ? { raw, pid, since }
    : undefined;
}

/**
 * Whether the lock was left by a worker that is gone (agbossjs/agboss#91): Stryker kills a test
 * runner that has run out its time without running its `afterAll`, and every other runner of the
 * shard then waited out `STALE_MS` behind its lock — a run that looked hung for an hour and read
 * as timeouts. The owner's pid is in the directory: a dead one frees the lock at once.
 */
const isStale = (owner: Owner): boolean =>
  !isAlive(owner.pid) || Date.now() - owner.since > STALE_MS;

/**
 * Removes the lock `path` when it is still the one whose owner file says `raw` (agbossjs/mongodb#101):
 * the directory is renamed to a name of its own first — one of several that do this wins, the rest
 * find nothing — and only then read and deleted. A lock that was another holder's by then (the one
 * judged stale was replaced between the read and the rename) is put back.
 */
async function removeIfOwnedBy(path: string, raw: string): Promise<void> {
  const trash = `${path}.removed-${randomUUID()}`;
  try {
    await rename(path, trash);
  } catch {
    return;
  }
  const seen = await readFile(join(trash, "owner"), "utf8").catch(() => undefined);
  if (seen !== raw) await rename(trash, path).catch(() => undefined);
  await rm(trash, { recursive: true, force: true });
}

/**
 * Takes the lock `path`: a directory made whole — its owner file written — before it is put in
 * place by one `rename`, which fails while another lock is there (a directory with a file in it is
 * never replaced). So the lock has no moment without an owner. Returns the owner file's text, the
 * proof of ownership `releaseLock` asks for.
 */
export async function acquireLock(path: string, waitMs = WAIT_MS, pollMs = 250): Promise<string> {
  const deadline = Date.now() + waitMs;
  const raw = `${String(process.pid)} ${String(Date.now())} ${randomUUID()}`;
  for (;;) {
    const mine = `${path}.new-${randomUUID()}`;
    await mkdir(mine);
    await writeFile(join(mine, "owner"), raw);
    try {
      await rename(mine, path);
      return raw;
    } catch {
      await rm(mine, { recursive: true, force: true });
    }
    const owner = await ownerOf(path);
    if (owner !== undefined && isStale(owner)) await removeIfOwnedBy(path, owner.raw);
    else if (Date.now() > deadline) throw new Error("the fail point lock was not released");
    else await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Gives the lock back, when it is still the holder's own: one reaped as stale is another's now. */
export const releaseLock = (path: string, raw: string): Promise<void> => removeIfOwnedBy(path, raw);

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
