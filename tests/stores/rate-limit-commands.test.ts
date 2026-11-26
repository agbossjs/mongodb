/**
 * agbossjs/agboss#1213: the rate limits beyond the contract. A release and a clear touch their own
 * key's document only; a plain read of a window is one `find` that writes nothing, drops the
 * counts that left the window (one exactly at its edge too), and a read with a limit is decided
 * by the limit and keeps no empty count.
 */
import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collections, MongoRateLimitRepository } from "../../src/index.js";
import { commandsOf, nameOf, type Sent } from "../support/command-log.js";
import { TestApplicationContext } from "../support/application-context.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

vi.mock("mongodb", async (importOriginal) => {
  const { reportingCommands } = await import("../support/command-log.js");
  return reportingCommands(await importOriginal());
});

const database = testDatabase();
const WINDOWS = Collections.RateLimitWindows;
const SLOTS = Collections.RateLimitSlots;
const LEASE = seconds(30);
const WINDOW = seconds(2);

beforeEach(() => emptyAll(database.url()));

function limitsOn(clock = new VirtualClock()): {
  limits: MongoRateLimitRepository;
  log: Sent[];
} {
  const connection = connectionTo(database.url());
  const log = commandsOf(connection);
  const limits = new MongoRateLimitRepository(connection, clock, new TestApplicationContext());
  return { limits, log };
}

interface RawDoc {
  _id: string;
  slots?: { slotId: string }[];
  buckets?: { amount: number }[];
}

const raw = (name: string) => connectionTo(database.url()).db.collection<RawDoc>(name);

describe("agbossjs/agboss#1213: a key's own document", () => {
  it("a release frees its own slot only, on its own key", async () => {
    const { limits } = limitsOn();
    await limits.acquire("other", 2, LEASE);
    const first = await limits.acquire("mine", 2, LEASE);
    const second = await limits.acquire("mine", 2, LEASE);
    if (first === undefined || second === undefined) throw new Error("the slots were free");

    await limits.release(first);

    const slotsOf = async (key: string): Promise<string[]> => {
      const found = await raw(SLOTS).findOne({ _id: key });
      return (found?.slots ?? []).map((slot) => slot.slotId);
    };
    expect(await slotsOf("mine")).toEqual([second.slotId]);
    expect(await slotsOf("other")).toHaveLength(1);
  });

  it("a clear forgets its own key's window only", async () => {
    const { limits } = limitsOn();
    await limits.addToWindow("other", 3, WINDOW);
    await limits.addToWindow("mine", 5, WINDOW);

    await limits.clearWindow("mine");

    expect(await limits.addToWindow("mine", 0, WINDOW)).toBe(0);
    expect(await limits.addToWindow("other", 0, WINDOW)).toBe(3);
  });
});

describe("agbossjs/agboss#1213: a window's read", () => {
  it("a plain read is one find and writes nothing, not even a window of a key never counted", async () => {
    const { limits, log } = limitsOn();

    expect(await limits.addToWindow("never", 0, WINDOW)).toBe(0);

    expect(log.map(nameOf)).toEqual([`find ${WINDOWS}`]);
    expect(await raw(WINDOWS).countDocuments()).toBe(0);
  });

  it("a read with a limit is decided by the limit, and keeps no count of 0", async () => {
    const { limits, log } = limitsOn();
    await limits.addToWindow("k", 5, WINDOW, 10);
    log.length = 0;

    expect(await limits.addToWindow("k", 0, WINDOW, 3)).toBeUndefined();
    expect(await limits.addToWindow("k", 0, WINDOW, 10)).toBe(5);

    expect(log.map(nameOf)).toEqual([`findAndModify ${WINDOWS}`, `findAndModify ${WINDOWS}`]);
    const found = await raw(WINDOWS).findOne({ _id: "k" });
    expect((found?.buckets ?? []).map((bucket) => bucket.amount)).toEqual([5]);
  });

  it("a read counts what is inside the window: a count at its edge is outside", async () => {
    const clock = new VirtualClock();
    const { limits } = limitsOn(clock);
    await limits.addToWindow("edge", 3, WINDOW);

    await clock.advance(seconds(1));
    expect(await limits.addToWindow("edge", 0, WINDOW)).toBe(3);

    await clock.advance(seconds(1));
    expect(await limits.addToWindow("edge", 0, WINDOW)).toBe(0);
  });
});
