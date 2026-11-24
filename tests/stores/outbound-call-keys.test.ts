/**
 * agbossjs/agboss#81: the keys of the outbound call store's Mongo statements that no mutant of
 * Stryker drops (it empties a whole literal, never removes one key), each proved by a test that
 * fails without it. An intent is saved in the fencing transaction, with no end; a move is of an
 * attempt that is still pending (a call that ended is never ended again, by either ending), a
 * claim moves the attempt the next move compares, and a failed call has its end for the sweep.
 *
 * A key left as it is, no test can tell it (the sweep's equivalent): the `$ne: null` of the
 * retention's filter beside its `$lt` (a comparison with a date never matches a null or a missing
 * field, by the server's type brackets: the key says what the comment above it does).
 */
import { OutboundCallStatus, StoreClock, StoreTimeSource } from "@agboss/core";
import { type EffectKey } from "@agboss/core/stores";
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { hours } from "@agboss/core/units";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Collections,
  MongoExecutionLeaseRepository,
  MongoOutboundCallRepository,
} from "../../src/index.js";
import { HandClock } from "../contracts/lease-races.js";
import { instanceConnection } from "../contracts/mongodb-store.js";
import { TestApplicationContext } from "../support/application-context.js";
import { commandsOf, nameOf } from "../support/command-log.js";
import { emptyAll, testDatabase } from "../support/database.js";

vi.mock("mongodb", async (importOriginal) => {
  const { reportingCommands } = await import("../support/command-log.js");
  return reportingCommands(await importOriginal());
});

const database = testDatabase();
const OWNER = "owner-1";
const FAILURE = { name: "Declined", code: "card.declined", message: "the card was declined" };

beforeEach(() => emptyAll(database.url()));

async function instance() {
  const clock = new HandClock();
  const store = new StoreClock(StoreTimeSource.Test, clock);
  const connection = await instanceConnection(database, "instance-1");
  const leases = new MongoExecutionLeaseRepository(
    connection,
    store,
    new TestApplicationContext({}, "instance-1"),
  );
  const lease = await leases.acquire("default", "call-root", hours(1));
  if (lease === undefined) throw new Error("the lease is held");
  const key: EffectKey = effectKeyForTesting({
    scopeKey: "default:call-root",
    tenantId: "default",
    leaseExecutionId: "call-root",
    token: lease.token,
    idempotencyKey: "call-root:charge-action:1",
    name: "charge",
  });
  const calls = new MongoOutboundCallRepository(connection, store);
  const saved = () =>
    calls.saveIfAbsent(key, {
      rootExecutionId: "call-root",
      executionId: "call-root",
      workflow: "charge-workflow",
      target: "payments",
      operation: "charge",
      idempotencyKey: `${key.idempotencyKey}:charge`,
      request: "{}",
      attempt: 1,
      attemptOwner: OWNER,
      step: { nodeId: "charge-action", visitNumber: 1 },
    });
  return { clock, connection, calls, key, saved };
}

const document = async (connection: Awaited<ReturnType<typeof instance>>["connection"]) =>
  connection.db
    .collection<{ _id: string } & Record<string, unknown>>(Collections.OutboundCalls)
    .findOne({}, { projection: { _id: 0, status: 1, attempt: 1, attemptOwner: 1, endedAt: 1 } });

describe("agbossjs/agboss#81: an intent is saved", () => {
  it("in the fencing transaction, as a pending call with no end", async () => {
    const { connection, saved } = await instance();
    const log = commandsOf(connection);

    expect(await saved()).toBe(true);

    // the sequence of its number is drawn before it, outside the transaction (nothing to fence)
    const writes = log.filter((one) => nameOf(one) === `update ${Collections.OutboundCalls}`);
    expect(writes.map((one) => one.inTransaction)).toEqual([true]);
    expect(await document(connection)).toEqual({
      ...{ status: OutboundCallStatus.Pending, attempt: 1, attemptOwner: OWNER },
      endedAt: null,
    });
  });
});

describe("agbossjs/agboss#81: a move is of a pending attempt", () => {
  it("a call that failed is not completed", async () => {
    const { calls, connection, key, saved } = await instance();
    await saved();
    expect(await calls.markFailed(key, OWNER, FAILURE, null)).toBe(true);

    expect(await calls.markCompleted(key, OWNER, "{}", null)).toBe(false);

    expect(await document(connection)).toMatchObject({ status: OutboundCallStatus.Failed });
    expect((await calls.findByKey(key))?.result).toBeUndefined();
  });

  it("a call that completed is not failed", async () => {
    const { calls, connection, key, saved } = await instance();
    await saved();
    expect(await calls.markCompleted(key, OWNER, '{"ok":true}', null)).toBe(true);

    expect(await calls.markFailed(key, OWNER, FAILURE, null)).toBe(false);

    expect(await document(connection)).toMatchObject({ status: OutboundCallStatus.Completed });
    expect((await calls.findByKey(key))?.failure).toBeUndefined();
  });

  it("a claim moves the attempt and its owner that the next move compares", async () => {
    const { calls, connection, key, saved } = await instance();
    await saved();
    const first = { status: OutboundCallStatus.Pending, attempt: 1, attemptOwner: OWNER };

    expect(await calls.markPending(key, first, { attempt: 2, attemptOwner: "owner-2" })).toBe(true);

    expect(await document(connection)).toMatchObject({ attempt: 2, attemptOwner: "owner-2" });
    expect(await calls.markPending(key, first, { attempt: 3, attemptOwner: "owner-3" })).toBe(
      false,
    );
    expect(
      await calls.markPending(
        key,
        { status: OutboundCallStatus.Pending, attempt: 2, attemptOwner: "owner-2" },
        { attempt: 3, attemptOwner: "owner-3" },
      ),
    ).toBe(true);
  });
});

describe("agbossjs/agboss#1317: the end of a call carries its expiry, read by the retention sweep", () => {
  it("a failed call has its expiry, as a completed one: the sweep removes both once it has come, never a pending one or one kept for good", async () => {
    const { calls, clock, connection, key, saved } = await instance();
    await saved();
    const expiresAt = new Date(clock.now().getTime() + 500);
    await calls.markFailed(key, OWNER, FAILURE, expiresAt);
    expect(await document(connection)).toMatchObject({ expiresAt });

    expect(await calls.deleteExpired(new Date(expiresAt.getTime() - 1))).toBe(0);
    expect(await document(connection)).not.toBeNull();
    expect(await calls.deleteExpired(expiresAt)).toBe(1);

    expect(await document(connection)).toBeNull();
  });

  it("a call ended with no expiry (Ttl.Forever) and a pending one are never removed", async () => {
    const { calls, clock, connection, key, saved } = await instance();
    await saved();
    expect(await calls.deleteExpired(new Date(clock.now().getTime() + 10_000))).toBe(0);
    await calls.markCompleted(key, OWNER, "{}", null);

    expect(await calls.deleteExpired(new Date(clock.now().getTime() + 10_000))).toBe(0);

    expect(await document(connection)).not.toBeNull();
  });
});
