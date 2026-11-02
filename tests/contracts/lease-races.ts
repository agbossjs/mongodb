import type { ExecutionLeaseRepository } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";

/**
 * agbossjs/agboss#527 — the race the lease contract does not run: two instances' `acquire` of one
 * free lease at once — a tree never leased, one released, one expired —, round after round, in
 * both orders. Exactly one is given the lease, at one epoch. A store that reads the lease, decides
 * in its code and then writes passes every other lease case and fails this one.
 */

/** Two instances' lease stores on one database, emptied first; closed by `close`. */
export interface LeaseRaceInstances {
  readonly first: ExecutionLeaseRepository;
  readonly second: ExecutionLeaseRepository;
  /** Lets the stores' time pass `by` ms (their clock, or a wait on the server's). */
  readonly advance: (by: number) => Promise<void>;
}

const ROUNDS = 40;
const LEASE = seconds(30);

type Free = "never leased" | "released" | "expired";

async function freed(instances: LeaseRaceInstances, root: string, how: Free): Promise<void> {
  if (how === "never leased") return;
  const held = await instances.first.acquire("default", root, LEASE);
  if (held === undefined) throw new Error(`the first take of ${root} was refused`);
  if (how === "released") await instances.first.release(held);
  else await instances.advance(LEASE + 1);
}

export function leaseRaceCases(name: string, build: () => Promise<LeaseRaceInstances>): void {
  describe(`lease races (${name})`, () => {
    for (const how of ["never leased", "released", "expired"] as const)
      it(`two instances take one ${how} lease at once, round after round: exactly one wins`, async () => {
        const instances = await build();
        for (let round = 0; round < ROUNDS; round += 1) {
          const root = `race-${how.replaceAll(" ", "-")}-${String(round)}`;
          await freed(instances, root, how);
          const [left, right] =
            round % 2 === 0
              ? [instances.first, instances.second]
              : [instances.second, instances.first];
          const taken = await Promise.all([
            left.acquire("default", root, LEASE),
            right.acquire("default", root, LEASE),
          ]);
          const winners = taken.filter((lease) => lease !== undefined);

          expect(winners, `round ${String(round)}`).toHaveLength(1);
        }
      }, 120_000);
  });
}

/** A store's time a test moves by hand (`isDatabaseTime` false: the stores take it as a literal). */
export class HandClock {
  #at = new Date("2026-01-05T09:00:00.000Z").getTime();
  readonly isDatabaseTime = false;

  now(): Date {
    return new Date(this.#at);
  }

  advance(by: number): Promise<void> {
    this.#at += by;
    return Promise.resolve();
  }
}
