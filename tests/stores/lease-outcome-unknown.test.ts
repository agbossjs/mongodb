/**
 * agbossjs/mongodb#100: a lease write that fails with an error the collection's own reading of a
 * reply does not name (a clock that cannot be read, a lease that cannot be read) is
 * `StoreOutcomeUnknownError` named after its operation — `acquire`, `renew`, `release`, `retire`,
 * `yield`, `reclaim` — for every one of them. The collection's errors are named after the
 * collection (`classified-db.ts`), so the operation's name is the one of everything else a write
 * of the store throws.
 */
import { StoreClock, StoreTimeSource, type ExecutionLease } from "@agboss/core";
import { StoreOutcomeSource, StoreOutcomeUnknownError } from "@agboss/core/stores";
import { seconds } from "@agboss/core/units";
import { beforeEach, describe, expect, it } from "vitest";
import { MongoExecutionLeaseRepository } from "../../src/index.js";
import { instanceConnection } from "../contracts/mongodb-store.js";
import { TestApplicationContext } from "../support/application-context.js";
import { emptyAll, testDatabase } from "../support/database.js";

const database = testDatabase();
const LEASE = seconds(30);
const BROKEN = new Error("unreadable");

beforeEach(() => emptyAll(database.url()));

const leasesOn = async (clock: StoreClock) =>
  new MongoExecutionLeaseRepository(
    await instanceConnection(database, "instance-1"),
    clock,
    new TestApplicationContext({}, "instance-1"),
  );

/** A lease held by the repository, whose tenant cannot be read: every filter built from it throws. */
const unreadable = (held: ExecutionLease): ExecutionLease =>
  Object.create(held, {
    tenantId: {
      get(): string {
        throw BROKEN;
      },
    },
  }) as ExecutionLease;

/** The error `run` rejects with. */
async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("it resolved: it should have rejected");
}

describe("agbossjs/mongodb#100: an error of a lease write that is not the collection's names the operation", () => {
  it("acquire", async () => {
    const clock = new StoreClock(StoreTimeSource.Test, {
      now: () => {
        throw BROKEN;
      },
    });
    const leases = await leasesOn(clock);

    const error = await rejection(() => leases.acquire("default", "root-a", LEASE));

    expect(error).toBeInstanceOf(StoreOutcomeUnknownError);
    expect(error).toMatchObject({
      operation: "acquire",
      source: StoreOutcomeSource.Transport,
      cause: BROKEN,
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
    const leases = await leasesOn(new StoreClock(StoreTimeSource.Test, { now: () => new Date() }));
    const held = await leases.acquire("default", `root-${operation}`, LEASE);
    if (held === undefined) throw new Error("the lease was not acquired");

    const error = await rejection(() => call(leases, unreadable(held)));

    expect(error).toBeInstanceOf(StoreOutcomeUnknownError);
    expect(error).toMatchObject({
      operation,
      source: StoreOutcomeSource.Transport,
      cause: BROKEN,
    });
  });
});
