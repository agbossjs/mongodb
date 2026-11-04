import {
  FAULT_SABOTAGE_SCENARIOS,
  FaultInvariant,
  FaultInvariantError,
  runFaultScenario,
} from "@agboss/core/testing/faults";
import { describe, expect, it } from "vitest";
import { faultShardOf, mongoFaultTarget, type FaultShard } from "./mongodb-target.js";

/**
 * agbossjs/agboss#657, #658 — the fault suite bites on MongoDB too: the fixture's payment
 * integration broken on purpose (every gateway error taken for a definite failure; no key
 * retention declared) charges twice on these stores, and `effects-once` says so — the same
 * scenarios 14 and 15 that pass in `faults.test.ts`. CI shards them like the suite: each runs in
 * one shard (`AGBOSS_FAULT_SHARD`, `k/n`), every one without a shard.
 */
const target = mongoFaultTarget();

/** Whether the `at`-th sabotage runs in `shard`: every `n`-th from the `k`-th, as the scenarios. */
const isInShard = (at: number, shard: FaultShard | undefined): boolean =>
  shard === undefined || at % shard.count === shard.index - 1;

const shard = faultShardOf(process.env.AGBOSS_FAULT_SHARD);
const sabotages = FAULT_SABOTAGE_SCENARIOS.filter((_, at) => isInShard(at, shard));

describe("agbossjs/agboss#657, #658: a broken payment integration fails effects-once on MongoDB", () => {
  it("the core's sabotages: an error taken for a definite one, a key retention left out", () => {
    expect(FAULT_SABOTAGE_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "s14-sabotage-every-error-definite",
      "s15-sabotage-retention-undeclared",
    ]);
  });

  it.each(sabotages.map((scenario) => [scenario.id, scenario] as const))(
    "%s: a second payment",
    async (_, scenario) => {
      const error: unknown = await runFaultScenario(scenario, target).then(
        () => undefined,
        (failure: unknown) => failure,
      );

      expect(error).toBeInstanceOf(FaultInvariantError);
      expect((error as FaultInvariantError).invariants).toContain(FaultInvariant.EffectsOnce);
      expect(
        (error as FaultInvariantError).violations.map((found) => found.message),
      ).toContainEqual(expect.stringMatching(/was paid 2 times at the gateway/u));
    },
    240_000,
  );
});
