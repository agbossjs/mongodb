/**
 * agbossjs/agboss#1341c: a reclaim under an Immediate pause hands out no token above the fence — the
 * reclaimed lease inherits it (`$max` of the fence and the new token) — while under an AfterStep
 * pause, after an unpause or with no pause the fence stays where it was (the contract's case runs it
 * against a server; this pins the command).
 */
import { StoreClock, StoreTimeSource } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { minutes } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { MongoExecutionLeaseRepository } from "../../src/index.js";
import { reclaimedFence, STORED_TOKEN } from "../../src/stores/lease-documents.js";
import { TestApplicationContext } from "../support/application-context.js";

describe("the fence of a reclaimed lease", () => {
  it("rises to the new token while the tree is paused Immediate, and stays otherwise", () => {
    const token = { $add: [STORED_TOKEN, 1] };

    expect(reclaimedFence(token)).toStrictEqual({
      $cond: [
        {
          $and: [
            { $eq: [{ $ifNull: ["$isExternallyPaused", false] }, true] },
            { $eq: ["$externalPauseMode", "immediate"] },
          ],
        },
        { $max: [{ $ifNull: ["$fencedThroughToken", 0] }, token] },
        "$fencedThroughToken",
      ],
    });
  });

  it("is in the reclaim's one update, beside the new token", async () => {
    const updates: unknown[][] = [];
    const collection = {
      findOneAndUpdate: (...args: unknown[]) => {
        updates.push(args);
        return Promise.resolve(null);
      },
    };
    const connection = { db: { collection: () => collection } } as never;
    const leases = new MongoExecutionLeaseRepository(
      connection,
      new StoreClock(StoreTimeSource.Test, new VirtualClock()),
      new TestApplicationContext(),
    );
    const held = { tenantId: "default", rootExecutionId: "r", holderInstanceId: "i", token: 2 };

    await leases.reclaim(held as never, minutes(1));

    const [stage] = (updates[0]?.[1] ?? []) as { $set: Record<string, unknown> }[];
    expect(stage?.$set.fencedThroughToken).toStrictEqual(
      reclaimedFence({ $add: [STORED_TOKEN, 1] }),
    );
    expect(stage?.$set.token).toStrictEqual({ $add: [STORED_TOKEN, 1] });
  });
});
