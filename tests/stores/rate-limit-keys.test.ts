/**
 * agbossjs/agboss#81: the keys of the rate limit's Mongo statements that no mutant of Stryker drops
 * (it empties a whole literal, never removes one key), each proved by a test that fails without
 * it. A renewal names the document of its own key (a slot id of another key's document is not
 * its slot), and a slot taken is stored with the instance that holds it.
 */
import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { beforeEach, describe, expect, it } from "vitest";
import { Collections, MongoRateLimitRepository } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();
const SLOTS = Collections.RateLimitSlots;
const LEASE = seconds(30);
const NOW = new Date("2026-10-18T08:00:00.000Z");

beforeEach(() => emptyAll(database.url()));

interface RawSlots {
  _id: string;
  slots: { slotId: string; holderInstanceId?: string; expiresAt: Date }[];
}

const raw = () => connectionTo(database.url()).db.collection<RawSlots>(SLOTS);

const limitsOn = (instanceId = "instance-1"): MongoRateLimitRepository =>
  new MongoRateLimitRepository(
    connectionTo(database.url()),
    new VirtualClock(NOW),
    new TestApplicationContext(instanceId),
  );

describe("agbossjs/agboss#81: a renewal and a slot", () => {
  it("a renewal is of its own key's document: the slot of another key is not renewed by it", async () => {
    const limits = limitsOn();
    const theirs = await limits.acquire("theirs", 2, LEASE);
    if (theirs === undefined) throw new Error("the slot was free");
    const before = await raw().findOne({ _id: "theirs" });

    expect(await limits.renew({ ...theirs, key: "mine" }, seconds(300))).toBe(false);

    expect(await raw().findOne({ _id: "theirs" })).toEqual(before);
    expect(await raw().findOne({ _id: "mine" })).toBeNull();
  });

  it("a slot taken is stored with its id, the instance that holds it and its expiry", async () => {
    const taken = await limitsOn("instance-7").acquire("k", 2, LEASE);

    expect(await raw().findOne({ _id: "k" })).toEqual({
      _id: "k",
      slots: [
        {
          slotId: taken?.slotId,
          holderInstanceId: "instance-7",
          expiresAt: new Date(NOW.getTime() + 30_000),
        },
      ],
    });
  });
});
