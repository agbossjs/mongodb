/**
 * agbossjs/agboss#1317 on MongoDB: a fenced effect's result, its scope's mark and its business key's
 * lock carry `expiresAt` (the key's `now + ttl`, `null` for `Ttl.Forever`); the mark and the lock keep
 * the LATEST expiry of the keys written under them — never over any date, a later over an earlier — so
 * a short ttl never truncates what a longer one relies on; `deleteExpired` removes what has come due.
 */
import { StoreClock, StoreTimeSource } from "@agboss/core";
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { hours, minutes } from "@agboss/core/units";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Collections,
  MongoExecutionLeaseRepository,
  MongoFencedEffectRepository,
} from "../../src/index.js";
import { HandClock } from "../contracts/lease-races.js";
import { instanceConnection } from "../contracts/mongodb-store.js";
import { TestApplicationContext } from "../support/application-context.js";
import { emptyAll, testDatabase } from "../support/database.js";

const database = testDatabase();
const NOW = new Date("2026-01-05T09:00:00.000Z");
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

beforeEach(() => emptyAll(database.url()));

async function instance() {
  const clock = new HandClock();
  const store = new StoreClock(StoreTimeSource.Test, clock);
  const connection = await instanceConnection(database, "instance-1");
  return {
    connection,
    effects: new MongoFencedEffectRepository(connection, store),
    leases: new MongoExecutionLeaseRepository(connection, store, new TestApplicationContext({})),
  };
}

const run = async (
  { effects, leases }: Awaited<ReturnType<typeof instance>>,
  name: string,
  expiresAt: Date | null,
  extra: { readonly businessKey?: string } = {},
) => {
  const lease = await leases.acquire("default", "root-1", hours(1));
  if (lease === undefined) throw new Error("no lease");
  const key = effectKeyForTesting({
    scopeKey: "default:root-1",
    tenantId: "default",
    leaseExecutionId: "root-1",
    token: lease.token,
    idempotencyKey: `root-1:${name}:1`,
    name,
    expiresAt,
    ...(extra.businessKey === undefined
      ? {}
      : { businessKey: extra.businessKey, withoutFingerprint: true as const }),
  });
  return effects.runOnce(key, () => ({ ok: name }));
};

const markOf = async (target: Awaited<ReturnType<typeof instance>>) =>
  target.connection.db
    .collection<{ _id: string; expiresAt: Date | null }>(Collections.FencedEffectMarks)
    .findOne({ _id: "default:root-1" });

describe("the expiry of a scope's mark", () => {
  it("keeps the latest expiry of the keys written under it; a short ttl after a long one does not truncate it", async () => {
    const target = await instance();

    await run(target, "long", later(minutes(30)));
    await run(target, "short", later(minutes(5)));
    expect((await markOf(target))?.expiresAt).toEqual(later(minutes(30)));

    await run(target, "longer", later(minutes(60)));
    expect((await markOf(target))?.expiresAt).toEqual(later(minutes(60)));
  });

  it("Ttl.Forever (null) wins over any date, and stays", async () => {
    const target = await instance();
    await run(target, "dated", later(minutes(5)));

    await run(target, "forever", null);
    await run(target, "dated-again", later(minutes(90)));

    expect((await markOf(target))?.expiresAt).toBeNull();
  });
});

describe("deleteExpired", () => {
  it("removes a result, a mark and a key lock once their expiry has come, and counts them; a forever row stays", async () => {
    const target = await instance();
    await run(target, "keyed", later(minutes(5)), { businessKey: "order:1" });
    const { connection, effects } = target;
    const count = (name: string) => connection.db.collection(name).countDocuments();

    expect(await effects.deleteExpired(later(minutes(4)))).toBe(0);
    expect(await effects.deleteExpired(later(minutes(5)))).toBe(3);

    expect(await count(Collections.FencedEffectResults)).toBe(0);
    expect(await count(Collections.FencedEffectMarks)).toBe(0);
    expect(await count(Collections.FencedKeyLocks)).toBe(0);
  });

  it("a result with no expiry is never removed", async () => {
    const target = await instance();
    await run(target, "forever", null);

    expect(await target.effects.deleteExpired(later(hours(24 * 365)))).toBe(0);
    expect(
      await target.connection.db.collection(Collections.FencedEffectResults).countDocuments(),
    ).toBe(1);
  });
});
