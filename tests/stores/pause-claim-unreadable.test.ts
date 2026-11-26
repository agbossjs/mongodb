/**
 * agbossjs/agboss#1307 (review #1419, L8): a claim of the notices' mailboxes sets aside one that does
 * not read — dead, with the problem the core's SQLite store writes — and goes on, instead of failing
 * the whole claim (and leaving the ones it had claimed held until their claim lapses).
 */
import { describe, expect, it } from "vitest";
import type { Db } from "mongodb";
import { claimDue, UNREADABLE_MAILBOX } from "../../src/stores/paused/pause-delivery.js";

const AT = new Date("2026-01-05T10:00:00.000Z");

const mailbox = (pauseId: string) => ({
  _id: `default\0${pauseId}\0listener:audit`,
  tenantId: "default",
  pauseId,
  recipient: "listener:audit",
  notices: [],
  delivered: 0,
  attempts: 0,
  nextAttemptAt: AT,
  headWrittenAt: null,
  isDead: false,
});

/** A database whose mailboxes collection hands out `documents` to the claims in order, then none, and logs its sets-aside. */
function database(documents: readonly unknown[]): { db: Db; updates: unknown[][] } {
  const queue = [...documents];
  const updates: unknown[][] = [];
  const collection = {
    findOneAndUpdate: () => Promise.resolve(queue.shift() ?? null),
    updateOne: (...args: unknown[]) => {
      updates.push(args);
      return Promise.resolve({ matchedCount: 1 });
    },
  };
  return { db: { collection: () => collection } as never, updates };
}

describe("agbossjs/agboss#1307: a claim and a mailbox that does not read", () => {
  it("is set aside under the claim's token, and the claim goes on to the next mailbox", async () => {
    const damaged = { _id: "default\0broken\0listener:audit", pauseId: "broken", notices: "?" };
    const { db, updates } = database([mailbox("one"), damaged, mailbox("two")]);

    const claims = await claimDue(db, AT, 5, 1000, ["listener:audit"]);

    expect(claims.map((claim) => claim.mailbox.pauseId)).toEqual(["one", "two"]);
    expect(updates).toHaveLength(1);
    const [filter, update] = updates[0] ?? [];
    expect(filter).toStrictEqual({
      _id: damaged._id,
      claimToken: expect.stringMatching(/^[0-9a-f]{32}$/u),
    });
    expect(update).toStrictEqual({
      $set: { isDead: true, problem: UNREADABLE_MAILBOX, claimToken: null, claimedUntil: null },
    });
  });

  it("a claim of readable mailboxes sets nothing aside", async () => {
    const { db, updates } = database([mailbox("one")]);

    expect(await claimDue(db, AT, 5, 1000, ["listener:audit"])).toHaveLength(1);
    expect(updates).toEqual([]);
  });
});
