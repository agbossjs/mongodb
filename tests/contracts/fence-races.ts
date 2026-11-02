import {
  ExecutionFencedError,
  type ExecutionLeaseRepository,
  type FencedEffectKey,
  type FencedEffectRepository,
} from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { setTimeout as wait } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { MongoTransaction } from "../../src/index.js";

/**
 * agbossjs/agboss#527 — the takeover inside a zombie's open fenced transaction, the one ordering the
 * contract suites cannot force: the old holder's check passed at its lease's last millisecond, its
 * work still runs, the lease expires and another instance takes it — while the transaction is open.
 * Then either the take waits for the transaction (the lease is locked by the check: the zombie's
 * write lands before the take, which is legal) or the transaction is refused. Never both: the take
 * granted while the zombie's transaction is open, and the zombie's write committed after it.
 */

/** Two instances' stores on one database, on one hand-moved store clock. */
export interface FenceRaceInstances {
  readonly first: {
    readonly effects: FencedEffectRepository<MongoTransaction>;
    readonly leases: ExecutionLeaseRepository;
  };
  readonly second: { readonly leases: ExecutionLeaseRepository };
  readonly advance: (by: number) => Promise<void>;
  /** The business rows committed so far, as another client reads them. */
  readonly committed: () => Promise<number>;
}

const LEASE = seconds(30);

export function fenceRaceCases(name: string, build: () => Promise<FenceRaceInstances>): void {
  describe(`fence races (${name})`, () => {
    it("a take while the zombie's fenced transaction is open waits for it, or the zombie is refused — never a write after the take", async () => {
      const { first, second, advance, committed } = await build();
      const lease = await first.leases.acquire("default", "zombie-1", LEASE);
      if (lease === undefined) throw new Error("the first take was refused");
      await advance(LEASE - 1);
      const key: FencedEffectKey = {
        scopeKey: "default:zombie-1",
        tenantId: "default",
        leaseExecutionId: "zombie-1",
        token: lease.leaseEpoch,
        idempotencyKey: "zombie-1:charge-action:1",
        name: "charge",
      };
      let takenDuringWork = false;
      let taking: Promise<unknown> | undefined;
      const write = first.effects.saveResultIfAbsent(key, async ({ db, session }) => {
        await db.collection("fence_race_rows").insertOne({ row: "zombie" }, { session });
        // the lease ends, and the other instance takes it while this transaction is open
        await advance(2);
        taking ??= second.leases.acquire("default", "zombie-1", LEASE);
        const taken = await Promise.race([taking, wait(1_000).then(() => "waiting")]);
        takenDuringWork = takenDuringWork || taken !== "waiting";
        return { receipt: "zombie" };
      });
      const outcome = await write.then(
        () => "landed",
        (error: unknown) => (error instanceof ExecutionFencedError ? "refused" : error),
      );
      await taking;

      // the take granted inside the transaction and the zombie's write landing: two owners' writes
      expect({ takenDuringWork, outcome }).not.toEqual({
        takenDuringWork: true,
        outcome: "landed",
      });
      expect(await committed()).toBe(outcome === "landed" ? 1 : 0);
    }, 60_000);
  });
}
