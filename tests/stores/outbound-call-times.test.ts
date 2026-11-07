/**
 * agbossjs/agboss#658, #745 on MongoDB, in the process: what a `reconcile` is told of a pending
 * attempt — when it started (`attemptStartedAt`) and when the store read it (`readAt`, which a key's
 * age is measured to) — is the server's time in production (`$$NOW`, the `checkedAt` the fence
 * writes on the lease it locks), whatever the instance's clock says: two instances, one two days
 * ahead and one two days behind, read the same times, close to the server's own. It bites: the same
 * store handed the caller's clock as its time (`TestStoreClock`) writes the skewed time.
 */
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import {
  Clock,
  DatabaseStoreClock,
  FingerprintRequiredError,
  type ExecutionLease,
  type EffectKey,
  type StoreClock,
} from "@agboss/core";
import { ClockSkew, SkewedClock, TestStoreClock } from "@agboss/core/testing";
import { hours, seconds, type Milliseconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MongoExecutionLeaseRepository, MongoOutboundCallRepository } from "../../src/index.js";
import { instanceConnection } from "../contracts/mongodb-store.js";
import { TestApplicationContext } from "../support/application-context.js";
import { testDatabase } from "../support/database.js";

const database = testDatabase();

/** The host's clock: real time. */
class HostClock extends Clock {
  now(): Date {
    return new Date();
  }

  sleep(delay: Milliseconds): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, delay);
    });
  }
}

const host = new HostClock();
const TWO_DAYS = hours(48);

/** Whose time the store decides by: the server's (production), or the calling instance's. */
type Time = "database" | "caller";

async function instanceOn(clock: Clock, time: Time, index: number) {
  const storeClock: StoreClock =
    time === "database" ? new DatabaseStoreClock(clock) : new TestStoreClock(clock);
  const instanceId = `instance-${String(index)}`;
  const connection = await instanceConnection(database, instanceId);
  return {
    connection,
    calls: new MongoOutboundCallRepository(connection, storeClock),
    leases: new MongoExecutionLeaseRepository(
      connection,
      storeClock,
      new TestApplicationContext({}, instanceId),
    ),
  };
}

const keyOf = (lease: ExecutionLease): EffectKey =>
  effectKeyForTesting({
    scopeKey: `${lease.tenantId}:${lease.rootExecutionId}`,
    tenantId: lease.tenantId,
    leaseExecutionId: lease.rootExecutionId,
    token: lease.leaseEpoch,
    idempotencyKey: `${lease.rootExecutionId}:charge-action:1`,
    name: "charge",
  });

const Hello = z.object({ localTime: z.date() });

/** The server's own time now (`hello`'s `localTime`, read on the primary). */
async function serverNow(instance: Awaited<ReturnType<typeof instanceOn>>): Promise<number> {
  return Hello.parse(await instance.connection.db.command({ hello: 1 })).localTime.getTime();
}

/** An intent saved by the instance ahead, read by the one behind: the times each read gives. */
async function timesOf(root: string, time: Time) {
  const ahead = await instanceOn(new SkewedClock(host, ClockSkew.ahead(TWO_DAYS)), time, 1);
  const behind = await instanceOn(new SkewedClock(host, ClockSkew.behind(TWO_DAYS)), time, 2);
  const lease = await ahead.leases.acquire("default", root, hours(72));
  if (lease === undefined) throw new Error(`the lease of ${root} is held`);
  const key = keyOf(lease);
  const before = await serverNow(ahead);
  await ahead.calls.saveIfAbsent(key, {
    rootExecutionId: root,
    executionId: root,
    workflow: "charge-workflow",
    target: "payments",
    operation: "charge",
    idempotencyKey: `${key.idempotencyKey}:charge`,
    request: "{}",
    attempt: 1,
    attemptOwner: "owner-1",
    step: { nodeId: "charge-action", visitNumber: 1 },
  });
  const read = await behind.calls.findByKey(key);
  const after = await serverNow(behind);
  const at = (text: string | undefined): number => Date.parse(text ?? "");
  return {
    before,
    after,
    started: at(read?.attemptStartedAt),
    first: at(read?.firstAttemptStartedAt),
    readAt: at(read?.readAt),
    recordedAt: at(read?.recordedAt),
  };
}

describe("agbossjs/agboss#658 on MongoDB: an attempt's start and its read are the server's time", () => {
  it("instances two days ahead and behind write and read the server's time; recordedAt stays the writer's clock", async () => {
    const times = await timesOf("execution-db", "database");

    // the server's time, to its milliseconds
    expect(times.started).toBeGreaterThanOrEqual(times.before - 1);
    expect(times.readAt).toBeLessThanOrEqual(times.after + 1);
    expect(times.first).toBe(times.started);
    expect(times.readAt).toBeGreaterThanOrEqual(times.started);
    expect(times.recordedAt - times.before).toBeGreaterThan(TWO_DAYS - seconds(60));
  });

  it("bites: the caller's clock as the store's time writes the skewed times — the key two days old for the reader behind, four days young", async () => {
    const times = await timesOf("execution-caller", "caller");

    expect(times.started - times.before).toBeGreaterThan(TWO_DAYS - seconds(60));
    expect(times.started - times.readAt).toBeGreaterThan(2 * TWO_DAYS - seconds(60));
  });
});

describe("agbossjs/agboss#825 on MongoDB: the key checked at the store's entry", () => {
  it("a business key without its fingerprint decision is refused, nothing written", async () => {
    const instance = await instanceOn(host, "database", 3);
    const lease = await instance.leases.acquire("default", "unfingerprinted", hours(1));
    if (lease === undefined) throw new Error("the lease is held");
    const key = effectKeyForTesting(keyOf(lease), { businessKey: "order:825" });
    const intent = {
      rootExecutionId: "unfingerprinted",
      executionId: "unfingerprinted",
      workflow: "charge-workflow",
      target: "payments",
      operation: "charge",
      idempotencyKey: `${key.idempotencyKey}:charge`,
      request: "{}",
      attempt: 1,
      attemptOwner: "owner-1",
      step: { nodeId: "charge-action", visitNumber: 1 },
    };

    await expect(instance.calls.saveIfAbsent(key, intent)).rejects.toBeInstanceOf(
      FingerprintRequiredError,
    );
    expect(
      await instance.calls.findAllByTenantIdAndRootExecutionId("default", "unfingerprinted"),
    ).toEqual([]);
  });
});
