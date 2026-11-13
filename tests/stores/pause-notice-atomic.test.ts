/**
 * agbossjs/agboss#938 AC1 — a change and its notices land together or not at all. The contract
 * cases read only what a store answers, so they cannot see a commit split in two; this test kills
 * the process between the notices' write and the commit (an error thrown there, which aborts the
 * transaction as a crash would) and reads the collections after. The second test is the same run on
 * a store that writes its outbox outside the session: it leaves the notice — the check bites.
 */
import { VirtualClock } from "@agboss/core/testing";
import { PauseStatus, type PauseRecord } from "@agboss/core";
import type { PauseRecipients } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import { MongoPausedExecutionRepository, type MongoTransaction } from "../../src/index.js";
import type { PlannedNotice } from "../../src/stores/paused/pause-changes.js";
import { mailboxIdOf, mailboxesOf } from "../../src/stores/paused/pause-mailboxes.js";
import { testDatabase } from "../support/database.js";
import { ANSWER, NINE, pauseOf } from "../support/pauses.js";
import { connectionTo } from "../support/stores.js";
import { OutsideSessionOutbox } from "./pause-sabotage.js";

const AUDIT: PauseRecipients = { listeners: ["audit"] };
const database = testDatabase();

const killed = (): Error => new Error("killed between the notices and the commit");

/** The correct store, killed after its notices were written and before it commits. */
class KilledBeforeCommit extends MongoPausedExecutionRepository {
  armed = false;

  protected override async appendNotices(
    transaction: MongoTransaction,
    pause: PauseRecord,
    notices: readonly PlannedNotice[],
  ): Promise<void> {
    await super.appendNotices(transaction, pause, notices);
    if (this.armed) throw killed();
  }
}

/** The outbox-outside-the-session store, killed the same way. */
class KilledOutside extends OutsideSessionOutbox {
  armed = false;

  protected override async appendNotices(
    transaction: MongoTransaction,
    pause: PauseRecord,
    notices: readonly PlannedNotice[],
  ): Promise<void> {
    await super.appendNotices(transaction, pause, notices);
    if (this.armed) throw killed();
  }
}

/** A sent pause `id` answered while the store is killed before its commit: what the collections hold after. */
async function answeredAndKilled(store: KilledBeforeCommit | KilledOutside, id: string) {
  await store.findOrCreateByStepKey(pauseOf(id));
  await store.markSentByTenantIdAndPauseId("default", id, { listeners: [] });
  store.armed = true;

  const outcome = store.resolveByTenantIdAndPauseId("default", id, ANSWER, NINE, AUDIT);

  await expect(outcome).rejects.toThrow(/killed/u);
  return {
    status: (await store.findByTenantIdAndPauseId("default", id))?.status,
    notices: await mailboxesOf(connectionTo(database.url()).db).countDocuments({
      _id: mailboxIdOf("default", id, "listener:audit"),
    }),
  };
}

describe("a change and its notices are one transaction", () => {
  it("a store killed before its commit leaves the pause Pending and writes no notice", async () => {
    const store = new KilledBeforeCommit(connectionTo(database.url()), new VirtualClock());

    expect(await answeredAndKilled(store, "p-atomic")).toEqual({
      status: PauseStatus.Pending,
      notices: 0,
    });
  });

  it("sabotage: with the outbox written outside the session, the same kill leaves the notice behind", async () => {
    const store = new KilledOutside(connectionTo(database.url()), new VirtualClock());

    expect(await answeredAndKilled(store, "p-outside")).toEqual({
      status: PauseStatus.Pending,
      notices: 1,
    });
  });
});
