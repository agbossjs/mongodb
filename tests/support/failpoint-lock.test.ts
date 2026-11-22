/**
 * agbossjs/mongodb#101: the fail-point lock has one holder at a time, also when several waiters
 * find the same dead owner at once, and a holder gives back only a lock that is still its own.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, markerOf, releaseLock } from "./dir-lock.js";

const paths: string[] = [];
const newPath = (): string => {
  const path = join(tmpdir(), `agboss-failpoint-lock-test-${randomUUID()}.lock`);
  paths.push(path);
  return path;
};
/** The markers and leftovers beside a lock path. */
const besides = (path: string): string[] =>
  readdirSync(tmpdir()).filter(
    (name) => name.startsWith(basename(path)) && name !== basename(path),
  );
afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const name of besides(path))
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
    rmSync(path, { recursive: true, force: true });
  }
});

/** A pid that was alive a moment ago and is not: a finished child of this process. */
const deadPid = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""]);
    child.once("error", reject);
    child.once("exit", () => {
      resolve(child.pid ?? 0);
    });
  });

/** A lock left by a dead worker, in the shape a holder writes. */
async function leftByDeadWorker(path: string): Promise<void> {
  mkdirSync(path);
  writeFileSync(join(path, "owner"), `${String(await deadPid())} ${String(Date.now())} left`);
}

describe("agbossjs/mongodb#101: one holder at a time", () => {
  it("waiters that find the same dead owner together never hold the lock together", async () => {
    for (let round = 0; round < 5; round += 1) {
      const path = newPath();
      await leftByDeadWorker(path);
      const inside = { now: 0, most: 0 };

      await Promise.all(
        Array.from({ length: 8 }, async () => {
          const held = await acquireLock(path, 20_000, 1);
          inside.now += 1;
          inside.most = Math.max(inside.most, inside.now);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inside.now -= 1;
          await releaseLock(path, held);
        }),
      );

      expect(inside.most).toBe(1);
      expect(existsSync(path)).toBe(false);
    }
  });

  it("a lock of a live holder is waited for, never taken", async () => {
    const path = newPath();
    const held = await acquireLock(path);

    await expect(acquireLock(path, 100, 10)).rejects.toThrow(
      "the fail point lock was not released",
    );
    expect(readFileSync(join(path, "owner"), "utf8")).toBe(held);
  });

  it("a lock held longer than the stale bound by a live worker is taken over", async () => {
    const path = newPath();
    mkdirSync(path);
    const longAgo = Date.now() - 16 * 60_000;
    writeFileSync(join(path, "owner"), `${String(process.pid)} ${String(longAgo)} hung`);

    const held = await acquireLock(path, 1_000, 10);

    expect(readFileSync(join(path, "owner"), "utf8")).toBe(held);
  });
});

describe("agbossjs/mongodb#101: a holder gives back its own lock only", () => {
  it("its own is removed", async () => {
    const path = newPath();
    const held = await acquireLock(path);

    await releaseLock(path, held);

    expect(existsSync(path)).toBe(false);
  });

  it("a lock another holder took (the first was reaped as stale) is left where it is", async () => {
    const path = newPath();
    const first = await acquireLock(path);
    rmSync(path, { recursive: true });
    const second = await acquireLock(path);

    await releaseLock(path, first);

    expect(readFileSync(join(path, "owner"), "utf8")).toBe(second);
  });

  it("giving back a lock that is not there is nothing", async () => {
    await expect(releaseLock(newPath(), "x")).resolves.toBeUndefined();
  });
});

/** A lock of a dead worker's, in the shape a holder writes: its owner file's text. */
async function deadOwnersLock(path: string): Promise<string> {
  mkdirSync(path);
  const raw = `${String(await deadPid())} ${String(Date.now())} dead`;
  writeFileSync(join(path, "owner"), raw);
  return raw;
}

describe("agbossjs/mongodb#101 (acceptance Q): a late reader of a dead owner never removes the lock that came after it", () => {
  it("three waiters behind one dead owner X: C took X's lock, A comes late to give X back — C's lock stays, E waits", async () => {
    const path = newPath();
    const x = await deadOwnersLock(path);
    const c = await acquireLock(path, 5_000, 1);

    await releaseLock(path, x);

    expect(readFileSync(join(path, "owner"), "utf8")).toBe(c);
    await expect(acquireLock(path, 150, 5)).rejects.toThrow("the fail point lock was not released");
    expect(readFileSync(join(path, "owner"), "utf8")).toBe(c);
    await releaseLock(path, c);
    expect(existsSync(path)).toBe(false);
  });

  it("the same holder's lock is removed once: a second remover of the same owner finds the marker and waits", async () => {
    const path = newPath();
    const x = await deadOwnersLock(path);
    const first = await acquireLock(path, 5_000, 1);

    // a waiter that read X before C took it, and is a reaper of X: X's marker is made, it removes nothing
    await releaseLock(path, x);
    const markers = besides(path).filter((name) => name.includes(".reaping-"));

    expect(markers).toHaveLength(1);
    expect(readFileSync(join(path, "owner"), "utf8")).toBe(first);
  });

  it.each([3, 5])(
    "%i waiters behind one dead owner, many rounds: never two inside",
    async (waiters) => {
      for (let round = 0; round < 15; round += 1) {
        const path = newPath();
        await deadOwnersLock(path);
        const inside = { now: 0, most: 0 };

        await Promise.all(
          Array.from({ length: waiters }, async () => {
            const held = await acquireLock(path, 20_000, 1);
            inside.now += 1;
            inside.most = Math.max(inside.most, inside.now);
            await new Promise((resolve) => setTimeout(resolve, 2));
            inside.now -= 1;
            await releaseLock(path, held);
          }),
        );

        expect(inside.most).toBe(1);
        expect(existsSync(path)).toBe(false);
      }
    },
  );
});

describe("agbossjs/mongodb#101: a remover that was killed", () => {
  it("a fresh marker with the dead owner's lock still there: the waiters wait for the remover", async () => {
    const path = newPath();
    const x = await deadOwnersLock(path);
    const marker = markerOf(path, x);
    mkdirSync(marker);

    await expect(acquireLock(path, 150, 5)).rejects.toThrow("the fail point lock was not released");
    expect(existsSync(path)).toBe(true);
  });

  it("a marker older than the removal may take, the lock still there: it is the dead remover's, the lock is removed", async () => {
    const path = newPath();
    const x = await deadOwnersLock(path);
    const marker = markerOf(path, x);
    mkdirSync(marker);
    const old = new Date(Date.now() - 60_000);
    utimesSync(marker, old, old);

    const held = await acquireLock(path, 2_000, 5);

    expect(readFileSync(join(path, "owner"), "utf8")).toBe(held);
  });

  it("the markers of locks gone for an hour are cleaned up by the next taker", async () => {
    const path = newPath();
    const tombstone = `${path}.reaping-0123456789abcdef01234567`;
    mkdirSync(tombstone);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(tombstone, old, old);

    await acquireLock(path);

    expect(existsSync(tombstone)).toBe(false);
  });
});
