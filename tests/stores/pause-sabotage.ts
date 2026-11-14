import { PauseStatus, type PauseRecord } from "@agboss/core";
import type {
  PauseNoticeClaim,
  PauseNoticeFacts,
  PauseNoticeKind,
  PauseRecipients,
} from "@agboss/core/stores";
import { MongoServerError } from "mongodb";
import type { MongoTransaction } from "../../src/index.js";
import { MongoPausedExecutionRepository } from "../../src/index.js";
import { idOf } from "../../src/stores/keys.js";
import { onceNotices } from "../../src/stores/paused/pause-marks.js";
import type { PlannedNotice } from "../../src/stores/paused/pause-changes.js";
import { pauseIdOf, pauseOfDocument } from "../../src/stores/paused/pause-documents.js";
import { PAUSE_GUARDS, inStatus, type PauseGuards } from "../../src/stores/paused/pause-guards.js";
import { appendNotice, mailboxesOf } from "../../src/stores/paused/pause-mailboxes.js";

/**
 * Broken pause stores (agbossjs/agboss#938): each breaks one rule the contract and the store's own
 * tests state, and the sabotage run expects them red. Each overrides the one seam its rule lives in.
 */

/** The collection `DuplicateKeyNoticeOnce` keeps its once-markers in (a test's reset empties it). */
export const MARKERS = "noticeonce_markers";

/** The deadline taken out of every compare-and-set: a pending pause is answered, expired, extended at any time. */
export class NoDeadlineGuards extends MongoPausedExecutionRepository {
  protected override get guards(): PauseGuards {
    const pending = (): ReturnType<typeof inStatus> => inStatus(PauseStatus.Pending);
    return {
      ...PAUSE_GUARDS,
      open: pending,
      due: pending,
      extendable: pending,
      remindable: pending,
    };
  }
}

/** The notices written outside the transaction's session: committed at once, whatever the change does. */
export class OutsideSessionOutbox extends MongoPausedExecutionRepository {
  protected override async appendNotices(
    transaction: MongoTransaction,
    pause: PauseRecord,
    notices: readonly PlannedNotice[],
  ): Promise<void> {
    for (const planned of notices) await appendNotice(transaction.db, undefined, pause, planned);
  }
}

/** The notices of one change written last to first. */
export class ReversedOrder extends MongoPausedExecutionRepository {
  protected override async appendNotices(
    transaction: MongoTransaction,
    pause: PauseRecord,
    notices: readonly PlannedNotice[],
  ): Promise<void> {
    await super.appendNotices(transaction, pause, [...notices].reverse());
  }
}

/** The head's time stored as an ISO string, not a Date: the stale look's `$lt: Date` never matches it. */
export class StringHeadTime extends MongoPausedExecutionRepository {
  async #stringify(): Promise<void> {
    await mailboxesOf(this.connection.db).updateMany({ headWrittenAt: { $type: "date" } }, [
      { $set: { headWrittenAt: { $dateToString: { date: "$headWrittenAt" } } } },
    ]);
  }

  protected override async appendNotices(
    transaction: MongoTransaction,
    pause: PauseRecord,
    notices: readonly PlannedNotice[],
  ): Promise<void> {
    await super.appendNotices(transaction, pause, notices);
    await mailboxesOf(transaction.db).updateMany(
      { headWrittenAt: { $type: "date" } },
      [{ $set: { headWrittenAt: { $dateToString: { date: "$headWrittenAt" } } } }],
      { session: transaction.session },
    );
  }

  override async ackNotice(
    claim: PauseNoticeClaim,
    at: Date,
  ): Promise<PauseNoticeClaim | undefined> {
    const next = await super.ackNotice(claim, at);
    await this.#stringify();
    return next;
  }
}

/** `noticeOnce` that relies on a duplicate-key error inside the transaction: an E11000 aborts it. */
export class DuplicateKeyNoticeOnce extends MongoPausedExecutionRepository {
  override noticeOnceByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    kind: PauseNoticeKind,
    facts: PauseNoticeFacts,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<boolean> {
    return this.connection.inTransaction(async (transaction) => {
      const { db, session } = transaction;
      const found = await this.pauses.findOne({ _id: pauseIdOf(tenantId, pauseId) }, { session });
      if (found === null) return false;
      const pause = pauseOfDocument(found);
      const planned = onceNotices(pause, kind, facts, at, recipients);
      if (planned.length === 0) return false;
      try {
        const markers = db.collection<{ _id: string }>(MARKERS);
        await markers.insertOne({ _id: idOf(tenantId, pauseId, kind) }, { session });
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) return false;
        throw error;
      }
      await this.appendNotices(transaction, pause, planned);
      return true;
    });
  }
}
