/**
 * agbossjs/agboss#1213: the notices' claim and the stale set-aside take the mailbox that is due, or
 * whose head is older, first — in the order of that time, not of the storing.
 */
import { seconds } from "@agboss/core/units";
import { VirtualClock } from "@agboss/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { MongoPausedExecutionRepository } from "../../src/index.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { NINE } from "../support/pauses.js";
import { insertMailboxRow } from "../support/pause-rows.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();
const minutesBefore = (minutes: number): Date => new Date(NINE.getTime() - minutes * 60_000);

beforeEach(() => emptyAll(database.url()));

const storeOn = () =>
  new MongoPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());

/** Two mailboxes stored the later one first: `newer` and `older`. */
async function twoMailboxes(): Promise<void> {
  const { db } = connectionTo(database.url());
  await insertMailboxRow(db, "newer", {
    headWrittenAt: minutesBefore(5),
    nextAttemptAt: minutesBefore(5),
  });
  await insertMailboxRow(db, "older", {
    headWrittenAt: minutesBefore(50),
    nextAttemptAt: minutesBefore(50),
  });
}

describe("agbossjs/agboss#1213: the order the mailboxes are taken in", () => {
  it("a claim of one takes the mailbox that has been due the longest", async () => {
    await twoMailboxes();

    const claims = await storeOn().claimNoticesDue(NINE, 1, seconds(30), ["listener:audit"]);

    expect(claims.map((claim) => claim.mailbox.pauseId)).toEqual(["older"]);
    expect(claims[0]?.mailbox).toMatchObject({
      tenantId: "default",
      recipient: "listener:audit",
      delivered: 0,
      attempts: 0,
      isDead: false,
    });
  });

  it("a set-aside of one takes the mailbox whose head is the oldest", async () => {
    await twoMailboxes();

    const aside = await storeOn().setAsideStaleNoticesBefore(NINE, NINE, "stale", 1);

    expect(aside).toEqual([{ tenantId: "default", pauseId: "older", recipient: "listener:audit" }]);
  });

  it("a mailbox with no head time is claimed and read as having none", async () => {
    const { db } = connectionTo(database.url());
    await insertMailboxRow(db, "headless", {
      headWrittenAt: null,
      nextAttemptAt: minutesBefore(5),
    });

    const claims = await storeOn().claimNoticesDue(NINE, 1, seconds(30), ["listener:audit"]);

    expect(claims[0]?.mailbox.pauseId).toBe("headless");
    expect(claims[0]?.mailbox.headWrittenAt).toBeUndefined();
  });
});
