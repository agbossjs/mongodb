import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import {
  ExecutionFencedError,
  FencedEffectSettings,
  StoreClock,
  StoreTimeSource,
} from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { hours } from "@agboss/core/units";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Collections,
  MongoExecutionLeaseRepository,
  MongoFencedEffectRepository,
} from "../../src/index.js";
import { instanceConnection } from "../contracts/mongodb-store.js";
import { TestApplicationContext } from "../support/application-context.js";
import { emptyAll, testDatabase } from "../support/database.js";

/**
 * The scope's mark is a fence of its own (#500): a key whose lease document holds its token is
 * still refused when a newer token wrote its scope. A lease document restored from a backup, or
 * set back by hand, never lets an older token write again.
 */
const database = testDatabase();

beforeEach(() => emptyAll(database.url()));

describe("the scope's mark", () => {
  it("a mark above the key's token refuses it: ExecutionFencedError naming the mark, nothing runs", async () => {
    const connection = await instanceConnection(database, "instance-1");
    const clock = new StoreClock(StoreTimeSource.Test, new VirtualClock());
    const leases = new MongoExecutionLeaseRepository(
      connection,
      clock,
      new TestApplicationContext({}, "instance-1"),
    );
    const effects = new MongoFencedEffectRepository(connection, clock, new FencedEffectSettings());
    const lease = await leases.acquire("default", "root-mark", hours(1));
    const token = lease?.token ?? 0;
    // a newer token of this scope wrote before the lease document was set back to `token`
    await connection.db
      .collection<{ _id: string; highestToken: number; storedAt: Date }>(
        Collections.FencedEffectMarks,
      )
      .insertOne({ _id: "default:root-mark", highestToken: token + 5, storedAt: new Date(0) });
    let runs = 0;

    const error = await effects
      .runOnce(
        effectKeyForTesting({
          scopeKey: "default:root-mark",
          tenantId: "default",
          leaseExecutionId: "root-mark",
          token,
          idempotencyKey: "root-mark:charge-action:1:charge",
          name: "charge",
        }),
        () => {
          runs += 1;
          return { receipt: "r1" };
        },
      )
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ExecutionFencedError);
    expect(error).toMatchObject({ scopeKey: "default:root-mark", token, observedToken: token + 5 });
    expect(runs).toBe(0);
  });
});
