import { PauseStatus, type PauseRecord } from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import type {
  PauseNoticeClaim,
  PauseNoticeFacts,
  PauseNoticeKind,
  PauseRecipients,
  PauseTimeoutChange,
} from "@agboss/core/stores";
import { onceNotices, seenOf, timeoutChange } from "@agboss/core/stores";
import type { PlannedNotice } from "@agboss/core/stores";
import { MongoServerError } from "mongodb";
import type { MongoTransaction } from "../../src/index.js";
import { MongoPausedExecutionRepository } from "../../src/index.js";
import { idOf } from "../../src/stores/keys.js";
import { pauseIdOf, pauseOfDocument } from "../../src/stores/paused/pause-documents.js";
import { PAUSE_GUARDS, inStatus, type PauseGuards } from "../../src/stores/paused/pause-guards.js";
import {
  appendNotice,
  mailboxIdOf,
  mailboxOf,
  mailboxesOf,
} from "../../src/stores/paused/pause-mailboxes.js";

/**
 * Broken pause stores (agbossjs/agboss#938): each breaks one rule the contract and the store's own
 * tests state, and the sabotage run expects them red. Each overrides the one seam its rule lives in.
 */

/** The collection `DuplicateKeyNoticeOnce` keeps its once-markers in (a test's reset empties it). */
export const MARKERS = "noticeonce_markers";

/** The deadline taken out of every compare-and-set: a pending pause is answered, expired, changed at any time. */
export class NoDeadlineGuards extends MongoPausedExecutionRepository {
  protected override get guards(): PauseGuards {
    const pending = (): ReturnType<typeof inStatus> => inStatus(PauseStatus.Pending);
    return {
      ...PAUSE_GUARDS,
      open: pending,
      due: pending,
      changeable: pending,
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

/**
 * A deadline change decided by the stale read alone (#1099, #1307): the compare-and-set's filter holds
 * only "pending, deadline after `at`", and the plan takes the deadline it just read for the one the
 * caller read — never the caller's. Two racing changes from one read both apply, the second one over
 * the first's; a stale `previousExpiresAt` is no refusal.
 */
export class TimeoutChangeWithoutCompare extends MongoPausedExecutionRepository {
  override changeTimeoutByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    change: PauseTimeoutChange,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    const guard = { status: PauseStatus.Pending, expiresAt: { $gt: at } };
    return this.change(tenantId, pauseId, at, guard, (before) =>
      timeoutChange(
        before,
        {
          ...change,
          ...(before.expiresAt === undefined ? {} : { previousExpiresAt: before.expiresAt }),
          seen: seenOf(before),
        },
        at,
        recipients,
      ),
    );
  }
}

/** A deadline change whose filter never looks at the deadline: one written after it is applied (#1148). */
export class ExtendAfterDeadline extends MongoPausedExecutionRepository {
  protected override get guards(): PauseGuards {
    return {
      ...PAUSE_GUARDS,
      changeable: (_at, previous) => ({
        status: PauseStatus.Pending,
        expiresAt: previous === undefined ? null : { $eq: previous },
      }),
    };
  }
}

/** A notice claim renewed for its token alone: a lapsed claim is revived, and `until` is set, never kept the later (#1131). */
export class RenewRevivesAndShortens extends MongoPausedExecutionRepository {
  override async renewNotice(
    claim: PauseNoticeClaim,
    at: Date,
    claimFor: Milliseconds,
  ): Promise<PauseNoticeClaim | undefined> {
    const { tenantId, pauseId, recipient } = claim.mailbox;
    const until = new Date(at.getTime() + claimFor);
    const after = await mailboxesOf(this.connection.db).findOneAndUpdate(
      { _id: mailboxIdOf(tenantId, pauseId, recipient), claimToken: claim.token },
      { $set: { claimedUntil: until } },
      { returnDocument: "after" },
    );
    return after === null ? undefined : { mailbox: mailboxOf(after), token: claim.token, until };
  }
}

/** The scans' keyset ignored: every page starts at the first due pause again (#942, #1070). */
export class ScansIgnoreAfter extends MongoPausedExecutionRepository {
  override findPendingByExpiresAtBefore(at: Date, limit: number): Promise<readonly PauseRecord[]> {
    return super.findPendingByExpiresAtBefore(at, limit);
  }

  override findPendingByRemindAtBefore(at: Date, limit: number): Promise<readonly PauseRecord[]> {
    return super.findPendingByRemindAtBefore(at, limit);
  }
}

/** A reassignment decided by the stale read alone (#946): the old pause's write has no condition, so two racing reassignments, or one after an answer, both apply. */
export class ReassignWithoutGuard extends MongoPausedExecutionRepository {
  protected override get guards(): PauseGuards {
    return { ...PAUSE_GUARDS, open: () => ({}) };
  }
}

/** A retention that removes a reassigned pause with the rest, though its replacement is still stored (#946). */
export class RetentionIgnoresChain extends MongoPausedExecutionRepository {
  override async deleteByResolvedAtBefore(cutoff: Date): Promise<void> {
    await this.pauses.deleteMany({
      status: { $in: [PauseStatus.Taken, PauseStatus.Cancelled] },
      resolvedAt: { $lt: cutoff },
    });
  }
}

/**
 * `noticeOnce` that writes nothing to the pause (#1103): the notice's mailbox is appended, but a
 * retention's delete of the closed pause — which has no mailbox yet in its snapshot — finds nothing
 * to conflict with and removes the pause beside the notice it never saw.
 */
export class NoPauseWriteNoticeOnce extends MongoPausedExecutionRepository {
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
      const written = await mailboxesOf(db).findOne(
        { tenantId, pauseId, "notices.kind": kind },
        { session },
      );
      if (written !== null) return false;
      await this.appendNotices(transaction, pause, planned);
      return true;
    });
  }
}
