/**
 * agbossjs/mongodb#101: the fail-point lock has one holder at a time, also when several waiters
 * find the same dead owner at once, and a holder gives back only a lock that is still its own.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, releaseLock } from "./failpoint-lock.js";

const paths: string[] = [];
const newPath = (): string => {
  const path = join(tmpdir(), `agboss-failpoint-lock-test-${randomUUID()}.lock`);
  paths.push(path);
  return path;
};
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
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
