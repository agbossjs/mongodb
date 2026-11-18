import type { Clock } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import type { Db } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";
import { MongoLiveLeasesError } from "../errors.js";

/**
 * The execution leases live on the server's clock (agbossjs/agboss#1104, ADR-0034): `released`,
 * `finished` and `superseded` all `false` and `expiresAt` after `$$NOW` — one aggregation, so the
 * instant is the server's, bound once, never this process's clock. A seed document (a cancel before
 * the first acquire, #1117: token 0, released) and a lease closed by a check are not live.
 */
const HOLDERS_SHOWN = 5;

const Live = z.object({
  _id: z.string(),
  count: z.number().int(),
  /** The longest time this holder's live leases have left, ms on the server's clock. */
  remaining: z.number(),
});

/** What the live leases are: how many, up to 5 sorted holders, and the longest time one has left (ms, 0 when none). */
interface LiveLeases {
  readonly count: number;
  readonly holders: readonly string[];
  readonly remaining: number;
}

/** One aggregation, one `$$NOW`: the count, the holders and the time left are of the same instant. */
async function liveLeasesOf(db: Db): Promise<LiveLeases> {
  const found = await db
    .collection(Collections.ExecutionLeases)
    .aggregate([
      {
        $match: {
          released: false,
          finished: false,
          superseded: false,
          $expr: { $gt: ["$expiresAt", "$$NOW"] },
        },
      },
      {
        $group: {
          _id: "$holderInstanceId",
          count: { $sum: 1 },
          remaining: { $max: { $subtract: ["$expiresAt", "$$NOW"] } },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  const holders = found.map((one) => Live.parse(one));
  return {
    count: holders.reduce((sum, one) => sum + one.count, 0),
    holders: holders.slice(0, HOLDERS_SHOWN).map((one) => one._id),
    remaining: Math.max(0, ...holders.map((one) => one.remaining)),
  };
}

/** Throws `MongoLiveLeasesError` when an execution lease is live (the count and up to 5 holders), else nothing. */
export async function refuseLiveLeases(db: Db): Promise<void> {
  const { count, holders } = await liveLeasesOf(db);
  if (count > 0) throw new MongoLiveLeasesError({ count, holders });
}

/** How long a start that migrates waits for live leases to lapse (at least `maxMs`, at most `capMs`), and how often it looks. */
export interface LeaseWait {
  readonly maxMs: number;
  readonly pollMs: number;
  /** The longest wait a long lease asks for: past it the start refuses (default 10 minutes). */
  readonly capMs?: number;
}

/** The longest wait of all: a lease that outlasts it (5 minutes and more) is refused, not waited for. */
const DEFAULT_CAP_MS = 600_000;

/**
 * The default wait: twice the core's default lease duration (30 s) — a stopped single instance's
 * own leases lapse within it, a running old instance renews its leases and outlasts it.
 */
export const DEFAULT_LEASE_WAIT: LeaseWait = { maxMs: 60_000, pollMs: 1_000 };

/**
 * How long the start waits, given the longest time a live lease has left: twice that, when it is
 * more than the default. A holder renews its lease long before it ends, so what is left of it is
 * at least three quarters of its duration: twice the remainder outlasts the lapse of a stopped
 * instance whatever its lease duration is (a custom 45 s lease waits 90 s). The default is the
 * floor and ten minutes the cap (agbossjs/agboss#1104: the lease duration is the holder's, the
 * database shows it).
 */
export const leaseWaitFor = (remainingMs: number, wait: LeaseWait): number =>
  Math.max(wait.maxMs, Math.min(2 * remainingMs, wait.capMs ?? DEFAULT_CAP_MS));

/** Waits `ms`: the polls' pace, never a decision. */
export type Sleep = (ms: number) => Promise<void>;

/** The wait on `clock` (the connection's); none without one: see `waitForLeasesToLapse`. */
export const sleepOn = (clock: Clock | undefined): Sleep | undefined =>
  clock === undefined ? undefined : (ms) => clock.sleep(seconds(ms / 1000));

/**
 * A start that migrates (`SchemaSetup.MigrateOnStart`, agbossjs/agboss#1104): looks for a live lease
 * every `pollMs` for `leaseWaitFor(...)`; one that lapses lets the start go on, one still live at
 * the end fails it with `MongoLiveLeasesError` (the old instances are not stopped: stop them first).
 * Whether a lease is live, and how long it has left, is the server's (`$$NOW`); the attempts are
 * counted, so the host's timer only paces them and never decides. The pace is the application's
 * `Clock` (no timer of the process is read here): a connection built without one (a script) cannot
 * wait, and refuses at once as `migrate` does.
 */
export async function waitForLeasesToLapse(
  db: Db,
  wait: LeaseWait,
  sleep: Sleep | undefined,
): Promise<void> {
  const first = await liveLeasesOf(db);
  if (first.count === 0) return;
  if (sleep === undefined)
    throw new MongoLiveLeasesError({ count: first.count, holders: first.holders });
  const attempts = Math.max(1, Math.ceil(leaseWaitFor(first.remaining, wait) / wait.pollMs));
  for (let attempt = 1; ; attempt += 1) {
    await sleep(wait.pollMs);
    const live = await liveLeasesOf(db);
    if (live.count === 0) return;
    if (attempt >= attempts)
      throw new MongoLiveLeasesError({ count: live.count, holders: live.holders });
  }
}
