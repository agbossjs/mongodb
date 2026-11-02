import { randomUUID } from "node:crypto";
import {
  ApplicationContext,
  Clock,
  Injectable,
  RateLimitRepository,
  type RateLimitLease,
} from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import type { Collection } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import {
  addToWindowPipeline,
  takeSlotPipeline,
  type BucketEntry,
  type SlotEntry,
} from "./rate-limits/rate-limit-pipelines.js";

interface SlotsDocument {
  _id: string;
  slots: SlotEntry[];
}

interface WindowDocument {
  _id: string;
  buckets: BucketEntry[];
  lastTotal: number;
  lastAccepted: boolean;
}

interface PauseDocument {
  _id: string;
  pausedUntil: Date;
}

const Slots = z.object({ slots: z.array(z.object({ slotId: z.string() })) });
const Window = z.object({
  buckets: z.array(z.object({ at: z.date(), amount: z.number() })).optional(),
});
const Decided = z.object({ lastTotal: z.number(), lastAccepted: z.boolean() });
const Pause = z.object({ pausedUntil: z.date() });

/**
 * `RateLimitRepository` on MongoDB (agbossjs/agboss#483, #527): a provider's `maxConcurrentCalls`,
 * per-minute windows, 429 pause and circuit breaker shared by every instance of the application —
 * each key **one document**, every change one command on it, atomic without a transaction:
 *
 * - **Slots** are an array of the key's document. `acquire` sweeps the expired ones and adds the
 *   new one under the count of the valid ones, in one update pipeline — so two instances never hold
 *   more than `maxSlots` together. `renew` extends only a slot still valid; `release` pulls it.
 * - **Windows** are an array of counts by `Clock` millisecond. `addToWindow` forgets the counts
 *   that left the window, sums the rest and adds to it only when the limit allows, in one pipeline;
 *   a plain read (`amount` 0, no limit) is one `findOne`.
 * - **Pauses** (a 429, an open breaker) keep the later one (`$max`).
 *
 * Times are the framework `Clock`'s, as literals.
 */
@Injectable({ deps: [MongoConnection, Clock, ApplicationContext] })
export class MongoRateLimitRepository extends RateLimitRepository {
  constructor(
    private readonly connection: MongoConnection,
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
  ) {
    super();
  }

  get #slots(): Collection<SlotsDocument> {
    return this.connection.db.collection<SlotsDocument>(Collections.RateLimitSlots);
  }

  get #windows(): Collection<WindowDocument> {
    return this.connection.db.collection<WindowDocument>(Collections.RateLimitWindows);
  }

  get #pauses(): Collection<PauseDocument> {
    return this.connection.db.collection<PauseDocument>(Collections.RateLimitPauses);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async acquire(
    key: string,
    maxSlots: number,
    lease: Milliseconds,
  ): Promise<RateLimitLease | undefined> {
    const now = this.clock.now();
    const slot: RateLimitLease = {
      key,
      slotId: randomUUID(),
      holderInstanceId: this.applicationContext.instanceId,
      expiresAt: new Date(now.getTime() + lease),
    };
    const after = await this.#slots.findOneAndUpdate(
      { _id: key },
      takeSlotPipeline(slot, maxSlots, now),
      { upsert: true, returnDocument: "after" },
    );
    const taken = Slots.parse(after).slots.some((one) => one.slotId === slot.slotId);
    return taken ? slot : undefined;
  }

  async renew(rateLimitLease: RateLimitLease, lease: Milliseconds): Promise<boolean> {
    const now = this.clock.now();
    const renewed = await this.#slots.updateOne(
      {
        _id: rateLimitLease.key,
        slots: { $elemMatch: { slotId: rateLimitLease.slotId, expiresAt: { $gt: now } } },
      },
      { $set: { "slots.$.expiresAt": new Date(now.getTime() + lease) } },
    );
    return renewed.matchedCount === 1;
  }

  async release(rateLimitLease: RateLimitLease): Promise<void> {
    await this.#slots.updateOne(
      { _id: rateLimitLease.key },
      { $pull: { slots: { slotId: rateLimitLease.slotId } } },
    );
  }

  async addToWindow(
    key: string,
    amount: number,
    window: Milliseconds,
    limit?: number,
  ): Promise<number | undefined> {
    const now = this.clock.now();
    const since = new Date(now.getTime() - window);
    if (amount === 0 && limit === undefined) {
      const found = Window.parse((await this.#windows.findOne({ _id: key })) ?? {});
      const inside = (found.buckets ?? []).filter(
        (bucket) => bucket.at.getTime() > since.getTime(),
      );
      return inside.reduce((sum, bucket) => sum + bucket.amount, 0);
    }
    const decided = Decided.parse(
      await this.#windows.findOneAndUpdate(
        { _id: key },
        addToWindowPipeline(amount, since, now, limit),
        { upsert: true, returnDocument: "after" },
      ),
    );
    return decided.lastAccepted ? decided.lastTotal : undefined;
  }

  async clearWindow(key: string): Promise<void> {
    await this.#windows.deleteOne({ _id: key });
  }

  async pauseUntil(key: string, until: Date): Promise<void> {
    await this.#pauses.updateOne({ _id: key }, { $max: { pausedUntil: until } }, { upsert: true });
  }

  async pausedUntil(key: string): Promise<Date | undefined> {
    const found = await this.#pauses.findOne({ _id: key });
    if (found === null) return undefined;
    const { pausedUntil } = Pause.parse(found);
    return pausedUntil.getTime() > this.clock.now().getTime() ? pausedUntil : undefined;
  }
}
