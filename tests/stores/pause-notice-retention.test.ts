/**
 * agbossjs/agboss#1103 item 2 — a one-time notice racing the retention's delete of a closed pause
 * that has no mailbox yet. The delete's snapshot shows no mailbox, so only the notice's write to the
 * pause record (`noticeWrites`) makes the two conflict: the delete runs again after the notice
 * committed, finds its mailbox and keeps the pause. A store that writes nothing to the pause loses
 * the pause (the second test: the sabotage).
 */
import { PauseNoticeKind, NO_RECIPIENTS, type PauseRecipients } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { PauseResolution, type PauseRecord } from "@agboss/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MongoPausedExecutionRepository,
  type MongoConnection,
  type MongoTransaction,
} from "../../src/index.js";
import type { PlannedNotice } from "../../src/stores/paused/pause-changes.js";
import { mailboxIdOf, mailboxesOf } from "../../src/stores/paused/pause-mailboxes.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { NINE, pauseOf } from "../support/pauses.js";
import { connectionTo } from "../support/stores.js";
import { NoPauseWriteNoticeOnce } from "./pause-sabotage.js";

const database = testDatabase();
beforeEach(() => emptyAll(database.url()));

const AUDIT: PauseRecipients = { listeners: ["audit"] };
const CUTOFF = new Date("2026-02-01T00:00:00.000Z");

/** What holds a store's `noticeOnce` open, its writes made, until `release` is called. */
class Gate {
  readonly reached: Promise<void>;
  #reach = (): void => undefined;
  #release = (): void => undefined;
  readonly #open: Promise<void>;

  constructor() {
    this.reached = new Promise((resolve) => {
      this.#reach = resolve;
    });
    this.#open = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  async hold(): Promise<void> {
    this.#reach();
    await this.#open;
  }

  release(): void {
    this.#release();
  }
}

class HeldNoticeOnce extends MongoPausedExecutionRepository {
  constructor(
    connection: MongoConnection,
    clock: VirtualClock,
    readonly gate: Gate,
  ) {
    super(connection, clock);
  }

  protected override async appendNotices(
    transaction: MongoTransaction,
    pause: PauseRecord,
    notices: readonly PlannedNotice[],
  ): Promise<void> {
    await this.gate.hold();
    await super.appendNotices(transaction, pause, notices);
  }
}

class HeldNoPauseWrite extends NoPauseWriteNoticeOnce {
  constructor(
    connection: MongoConnection,
    clock: VirtualClock,
    readonly gate: Gate,
  ) {
    super(connection, clock);
  }

  protected override async appendNotices(
    transaction: MongoTransaction,
    pause: PauseRecord,
    notices: readonly PlannedNotice[],
  ): Promise<void> {
    await this.gate.hold();
    await super.appendNotices(transaction, pause, notices);
  }
}

/** A sent pause `id`, cancelled at nine with no recipient: no mailbox exists for it. */
async function closedWithoutMailbox(store: MongoPausedExecutionRepository, id: string) {
  await store.findOrCreateByStepKey(pauseOf(id));
  await store.markSentByTenantIdAndPauseId("default", id, NO_RECIPIENTS);
  await store.cancelByTenantIdAndPauseId(
    "default",
    id,
    PauseResolution.Cancelled,
    NINE,
    NO_RECIPIENTS,
  );
}

async function noticeRacingRetention(
  Store: typeof HeldNoticeOnce | typeof HeldNoPauseWrite,
  id: string,
): Promise<{ pauseKept: boolean; mailbox: boolean }> {
  const connection = connectionTo(database.url());
  const gate = new Gate();
  const store = new Store(connection, new VirtualClock(), gate);
  await closedWithoutMailbox(
    new MongoPausedExecutionRepository(connectionTo(database.url()), new VirtualClock()),
    id,
  );
  const noticing = store.noticeOnceByTenantIdAndPauseId(
    "default",
    id,
    PauseNoticeKind.JoinFailed,
    { launch: "run-1:join:1" },
    NINE,
    AUDIT,
  );
  await gate.reached;
  const retention = new MongoPausedExecutionRepository(
    connectionTo(database.url()),
    new VirtualClock(),
  ).deleteByResolvedAtBefore(CUTOFF);
  // the retention runs (and, correctly, conflicts and runs again) while the notice's write is open
  await new Promise((resolve) => setTimeout(resolve, 300));
  gate.release();
  await Promise.all([noticing, retention]);
  return {
    pauseKept: (await store.findByTenantIdAndPauseId("default", id)) !== undefined,
    mailbox:
      (await mailboxesOf(connection.db).countDocuments({
        _id: mailboxIdOf("default", id, "listener:audit"),
      })) > 0,
  };
}

describe("agbossjs/agboss#1103: a one-time notice and the retention's delete", () => {
  it("the delete waits for the notice, finds its mailbox and keeps the pause", async () => {
    const outcome = await noticeRacingRetention(HeldNoticeOnce, "p-retention");

    expect(outcome).toEqual({ pauseKept: true, mailbox: true });
  });

  it("sabotage: a noticeOnce that writes nothing to the pause loses the pause under the delete", async () => {
    const outcome = await noticeRacingRetention(HeldNoPauseWrite, "p-lost");

    expect(outcome.pauseKept).toBe(false);
  });
});
