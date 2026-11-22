import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * A lock that is a directory (the fail-point lock of `failpoint-lock.ts`), taken and given back by
 * processes that can be killed at any moment (Stryker kills a test runner that has run out its time
 * without running its `afterAll`: agbossjs/agboss#91).
 *
 * - **Taking.** The lock directory is made whole — its `owner` file written, with the pid, the time
 *   and a token no other holder has — under a name of its own, and put in place by one `rename`,
 *   which fails while another lock is there (a directory with a file in it is never replaced): the
 *   lock is never without an owner.
 * - **Removing, the one rule (agbossjs/mongodb#101).** A lock is removed by whoever first makes the
 *   *removal marker* of that holder's token (`<lock>.reaping-<hash of the token>`, one `mkdir`): its
 *   holder giving it back, or a waiter that found the holder dead (or past `STALE_MS`). A token is
 *   one holder's, so the marker is made once for it, ever: of any number of waiters that read the
 *   same dead owner, one removes it and the rest wait. And since only the marker's maker removes that
 *   holder's lock, the path holds that holder's lock until it does: nobody can remove, or take for
 *   removal, another holder's lock that came after. Nothing is ever put back.
 * - **What is left.** A remover killed between its marker and its `rename` leaves the lock and the
 *   marker: the marker older than `REAP_STALE_MS` with the lock still there is the dead remover's,
 *   and is made again by whoever finds it (two of those can both succeed: this needs a dead pid, then a
 *   second death within `REAP_STALE_MS`, then two waiters in the same millisecond — it is the one window
 *   left, and it ends in two holders for one file, never a lock nobody can take). A marker of a lock
 *   that is gone is cleaned up after `TOMBSTONE_MS`.
 */

/** A lock older than this was left by a worker that hung (its owner is alive and holds it). */
export const STALE_MS = 15 * 60_000;
/** How long a removal may take before its marker is read as its dead maker's. */
const REAP_STALE_MS = 30_000;
/** How long a marker of a removed lock is kept (it blocks a late reader of the same dead owner). */
const TOMBSTONE_MS = 60 * 60_000;
export const WAIT_MS = 20 * 60_000;

/** What a lock's `owner` file says: who holds it, since when, and a token no other holder has. */
interface Owner {
  readonly raw: string;
  readonly pid: number;
  readonly since: number;
}

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

/** The holder written in the lock `path`; `undefined` when there is no lock, or none that reads. */
async function ownerOf(path: string): Promise<Owner | undefined> {
  const raw = await readFile(join(path, "owner"), "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  const [pid, since] = raw.split(" ").map(Number);
  return Number.isInteger(pid) && pid !== undefined && pid > 0 && since !== undefined
    ? { raw, pid, since }
    : undefined;
}

const isStale = (owner: Owner): boolean =>
  !isAlive(owner.pid) || Date.now() - owner.since > STALE_MS;

const MARKER = ".reaping-";

/** The removal marker of the holder whose owner file says `raw`. */
export const markerOf = (path: string, raw: string): string =>
  `${path}${MARKER}${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;

const exists = (error: unknown): boolean => (error as { code?: string }).code === "EEXIST";

/** Makes `marker`; `false` when it is there. */
async function makeMarker(marker: string): Promise<boolean> {
  try {
    await mkdir(marker);
    return true;
  } catch (error) {
    if (exists(error)) return false;
    throw error;
  }
}

/**
 * Whether the caller is the one to remove the lock of the holder `raw`: it made the marker; or the
 * marker is a dead remover's (older than `REAP_STALE_MS`, and the lock still the holder's) and the
 * caller made it again.
 */
async function claimRemoval(path: string, raw: string): Promise<boolean> {
  const marker = markerOf(path, raw);
  if (await makeMarker(marker)) return true;
  const made = await stat(marker).catch(() => undefined);
  if (made === undefined || Date.now() - made.mtimeMs <= REAP_STALE_MS) return false;
  if ((await ownerOf(path))?.raw !== raw) return false;
  await rm(marker, { recursive: true, force: true });
  return makeMarker(marker);
}

/** Removes the lock of the holder `raw`, which the caller has the marker of: renamed away, then deleted. */
async function removeClaimed(path: string, raw: string): Promise<void> {
  const trash = `${path}.removed-${randomUUID()}`;
  try {
    await rename(path, trash);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return;
    throw error;
  }
  const seen = await readFile(join(trash, "owner"), "utf8").catch(() => undefined);
  await rm(trash, { recursive: true, force: true });
  // only the maker of this holder's marker removes its lock, so the path held it: another is a bug, never silent
  if (seen !== raw) throw new Error(`the lock ${path} changed hands while it was being removed`);
}

/** Removes the markers of locks gone for `TOMBSTONE_MS`: no reader of that dead owner is still waiting. */
async function sweepMarkers(path: string): Promise<void> {
  const prefix = `${basename(path)}${MARKER}`;
  const names = await readdir(dirname(path)).catch(() => [] as string[]);
  for (const name of names.filter((one) => one.startsWith(prefix))) {
    const marker = join(dirname(path), name);
    const made = await stat(marker).catch(() => undefined);
    if (made !== undefined && Date.now() - made.mtimeMs > TOMBSTONE_MS)
      await rm(marker, { recursive: true, force: true });
  }
}

/**
 * Takes the lock `path`, waiting up to `waitMs`, polling every `pollMs`; the owner file's text is
 * the proof of ownership `releaseLock` asks for.
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
      await sweepMarkers(path);
      return raw;
    } catch {
      await rm(mine, { recursive: true, force: true });
    }
    const owner = await ownerOf(path);
    if (owner !== undefined && isStale(owner) && (await claimRemoval(path, owner.raw))) {
      await removeClaimed(path, owner.raw);
      continue;
    }
    if (Date.now() > deadline) throw new Error("the fail point lock was not released");
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Gives the lock back, when it is still the holder's own: one removed as stale is another's now. */
export async function releaseLock(path: string, raw: string): Promise<void> {
  if ((await ownerOf(path))?.raw !== raw) return;
  if (await claimRemoval(path, raw)) await removeClaimed(path, raw);
}
