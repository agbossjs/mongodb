/**
 * agbossjs/mongodb#100: every write of the lease store whose reply was lost is
 * `StoreOutcomeUnknownError` and names its own operation (`acquire`, `renew`, `release`, `retire`,
 * `yield`, `reclaim`), whatever the shard's other tests catch. The reply is lost by a collection
 * whose every call fails as a dropped connection does: deterministic, with no fail point.
 */
import { StoreClock, StoreTimeSource, type ExecutionLease } from "@agboss/core";
import { StoreOutcomeSource, StoreOutcomeUnknownError } from "@agboss/core/stores";
import { seconds } from "@agboss/core/units";
import { MongoNetworkError } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoExecutionLeaseRepository } from "../../src/index.js";
import { HandClock } from "../contracts/lease-races.js";
import { instanceConnection } from "../contracts/mongodb-store.js";
import { TestApplicationContext } from "../support/application-context.js";
import { emptyAll, testDatabase } from "../support/database.js";

const database = testDatabase();
const LEASE = seconds(30);

beforeEach(() => emptyAll(database.url()));
afterEach(() => {
  vi.restoreAllMocks();
});

async function setup() {
  const connection = await instanceConnection(database, "instance-1");
  const leases = new MongoExecutionLeaseRepository(
    connection,
    new StoreClock(StoreTimeSource.Test, new HandClock()),
    new TestApplicationContext({}, "instance-1"),
  );
  const lost = new MongoNetworkError("the reply was lost");
  /** From now on every call of every collection fails as a dropped connection does. */
  const dropReplies = (): void => {
    const failing = new Proxy({}, { get: () => () => Promise.reject(lost) });
    vi.spyOn(connection.db, "collection").mockReturnValue(failing as never);
  };
  return { leases, lost, dropReplies };
}

/** The error `run` rejects with. */
async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("it resolved: it should have rejected");
}

describe("agbossjs/mongodb#100: a lost reply of a lease write names the operation", () => {
  it("acquire", async () => {
    const { leases, lost, dropReplies } = await setup();
    dropReplies();

    const error = await rejection(() => leases.acquire("default", "root-a", LEASE));

    expect(error).toBeInstanceOf(StoreOutcomeUnknownError);
    expect(error).toMatchObject({
      operation: "acquire",
      source: StoreOutcomeSource.Transport,
      cause: lost,
    });
  });

  it.each<
    [string, (leases: MongoExecutionLeaseRepository, held: ExecutionLease) => Promise<unknown>]
  >([
    ["renew", (leases, held) => leases.renew(held, LEASE)],
    ["release", (leases, held) => leases.release(held)],
    ["retire", (leases, held) => leases.retire(held)],
    ["yield", (leases, held) => leases.yield(held)],
    ["reclaim", (leases, held) => leases.reclaim(held, LEASE)],
  ])("%s", async (operation, call) => {
    const { leases, lost, dropReplies } = await setup();
    const held = await leases.acquire("default", `root-${operation}`, LEASE);
    if (held === undefined) throw new Error("the lease was not acquired");
    dropReplies();

    const error = await rejection(() => call(leases, held));

    expect(error).toBeInstanceOf(StoreOutcomeUnknownError);
    expect(error).toMatchObject({ operation, source: StoreOutcomeSource.Transport, cause: lost });
  });
});
