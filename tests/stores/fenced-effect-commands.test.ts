/**
 * The fenced effect store's transaction as the client sends it, on a recording fake (no server): the
 * business key's lock with its time and expiry, the stored result looked up by the key's identity and
 * after a rotation of the idempotency secret by the previous digest's.
 */
import { IdempotencyRunStatus, StoreClock, StoreTimeSource } from "@agboss/core";
import { effectKeyIdentityOf } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { describe, expect, it } from "vitest";
import { Collections, MongoFencedEffectRepository } from "../../src/index.js";
import { latestExpiry } from "../../src/stores/fence.js";
import { previousIdOf } from "../../src/stores/key-entry.js";
import { idOf } from "../../src/stores/keys.js";
import { pageLimitOf } from "../../src/stores/outbound-call-pages.js";

const SESSION = { id: "session" };
const NOW = new Date("2026-01-05T09:00:00.000Z");
const EXPIRES = new Date("2026-01-05T10:00:00.000Z");

const keyOf = (extra: object = {}) =>
  effectKeyForTesting({
    scopeKey: "default:root-1",
    tenantId: "default",
    leaseExecutionId: "root-1",
    token: 1,
    idempotencyKey: "root-1:charge:1",
    name: "charge",
    expiresAt: EXPIRES,
    ...extra,
  });
const rotated = () =>
  keyOf({ businessKey: "digest-new", previousBusinessKey: "digest-old", withoutFingerprint: true });

/** A store on a fake database; `stored` are the answers of the results' lookups, in order. */
function storeOn(stored: (object | null)[]) {
  const log: unknown[][] = [];
  const answers = [...stored];
  const collection = (name: string) => ({
    updateOne: (...args: unknown[]) => {
      log.push([name, "updateOne", ...args]);
      return Promise.resolve({ matchedCount: 1 });
    },
    findOne: (...args: unknown[]) => {
      log.push([name, "findOne", ...args]);
      if (name === Collections.FencedEffectResults) return Promise.resolve(answers.shift() ?? null);
      return Promise.resolve({
        token: 1,
        expiresAt: new Date(NOW.getTime() + 3_600_000),
        released: false,
        checkedAt: NOW,
      });
    },
    findOneAndUpdate: (...args: unknown[]) => {
      log.push([name, "findOneAndUpdate", ...args]);
      return Promise.resolve({ highestToken: 1 });
    },
    insertOne: (...args: unknown[]) => {
      log.push([name, "insertOne", ...args]);
      return Promise.resolve({});
    },
  });
  const db = { collection };
  const connection = {
    db,
    inTransaction: (work: (transaction: unknown) => unknown) =>
      Promise.resolve(work({ db, session: SESSION })),
  } as never;
  const store = new MongoFencedEffectRepository(
    connection,
    new StoreClock(StoreTimeSource.Test, new VirtualClock(NOW)),
  );
  return { store, log };
}

const REPLAY = { token: 1, result: '{"ok":true}' };
const resultsFinds = (log: unknown[][]) =>
  log.filter((one) => one[0] === Collections.FencedEffectResults && one[1] === "findOne");

describe("a fenced effect on a business key", () => {
  it("locks the key's identity with the time it was taken at and the latest expiry", async () => {
    const { store, log } = storeOn([REPLAY]);
    const key = rotated();

    await store.runOnce(key, () => ({ ok: true }));

    const lock = log.find((one) => one[0] === Collections.FencedKeyLocks);
    expect(lock?.[2]).toStrictEqual({ _id: idOf(effectKeyIdentityOf(key)) });
    const [stage] = lock?.[3] as { $set: Record<string, unknown> }[];
    expect(stage?.$set.lockedAt).toStrictEqual(NOW);
    expect(stage?.$set.expiresAt).toStrictEqual(latestExpiry(EXPIRES));
    expect(lock?.[4]).toStrictEqual({ upsert: true, session: SESSION });
  });

  it("replays the result stored under the key's own identity, and asks no further", async () => {
    const { store, log } = storeOn([REPLAY]);
    const key = rotated();

    const outcome = await store.runOnce(key, () => ({ ok: false }));

    expect(outcome.status).toBe(IdempotencyRunStatus.Replayed);
    expect(resultsFinds(log).map((one) => one[2])).toStrictEqual([
      { _id: idOf(effectKeyIdentityOf(key)) },
    ]);
  });

  it("replays the result the previous digest stored, asked in the same session, when the own one is not there", async () => {
    const { store, log } = storeOn([null, REPLAY]);
    const key = rotated();

    const outcome = await store.runOnce(key, () => ({ ok: false }));

    expect(outcome.status).toBe(IdempotencyRunStatus.Replayed);
    expect(resultsFinds(log).map((one) => one.slice(2))).toStrictEqual([
      [{ _id: idOf(effectKeyIdentityOf(key)) }, { session: SESSION }],
      [{ _id: previousIdOf(key) }, { session: SESSION }],
    ]);
  });

  it("runs the work once when neither is there, and stores its result", async () => {
    const { store, log } = storeOn([null, null]);

    const outcome = await store.runOnce(rotated(), () => ({ ok: true }));

    expect(outcome).toMatchObject({ status: IdempotencyRunStatus.Ran, result: { ok: true } });
    expect(log.map((one) => one[1])).toContain("insertOne");
  });

  it("a key with no business key asks only for its own identity", async () => {
    const { store, log } = storeOn([null]);

    await store.runOnce(keyOf(), () => ({ ok: true }));

    expect(resultsFinds(log)).toHaveLength(1);
  });
});

describe("the page of the outbound calls' listing", () => {
  it("has a default size of a hundred when none is asked", () => {
    expect(pageLimitOf(undefined)).toBe(100);
    expect(pageLimitOf(7)).toBe(7);
  });
});
