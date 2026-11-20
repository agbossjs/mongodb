import {
  PauseResolution,
  PauseStatus,
  type PauseAnswer,
  type PauseCancellation,
  type PauseRecord,
} from "@agboss/core";
import type {
  PauseExpiry,
  PauseDeadlineChange,
  PauseNoticeFacts,
  PauseNoticeKind,
  PauseRecipients,
  PauseReplacement,
  PauseUntakenResolution,
} from "@agboss/core/stores";
import { MongoPauseBase } from "./pause-base.js";
import {
  cancelChange,
  closeUntakenChange,
  expireChange,
  extendChange,
  remindChange,
  resolveChange,
} from "./pause-changes.js";
import { findOrCreatePause, pauseIdOf, pauseOfDocument, fieldsOf } from "./pause-documents.js";
import { markSentChange } from "./pause-marks.js";
import { noticeOnceIn } from "./pause-once.js";
import { reassignIn, type PauseParts } from "./pause-reassign.js";

/**
 * The second layer (#938): the pause records and every transition of one pause. Each is one
 * compare-and-set in a transaction with its notices (`MongoPauseBase.change`); the guard is the
 * transition's condition — the deadline included —, so of two instances exactly one records it.
 */
export abstract class MongoPauseTransitions extends MongoPauseBase {
  findOrCreateByStepKey(pause: PauseRecord): Promise<PauseRecord> {
    return findOrCreatePause(this.connection.db, pause);
  }

  async findByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
  ): Promise<PauseRecord | undefined> {
    const found = await this.pauses.findOne({ _id: pauseIdOf(tenantId, pauseId) });
    return found === null ? undefined : pauseOfDocument(found);
  }

  async findByTenantIdAndRootExecutionIdAndStepKey(
    tenantId: string,
    rootExecutionId: string,
    stepKey: string,
  ): Promise<PauseRecord | undefined> {
    const found = await this.pauses.findOne({ tenantId, rootExecutionId, stepKey });
    return found === null ? undefined : pauseOfDocument(found);
  }

  async findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly PauseRecord[]> {
    const found = await this.pauses.find({ tenantId, rootExecutionId }).sort({ seq: 1 }).toArray();
    return found.map(pauseOfDocument);
  }

  /** Marks the channel asked whatever the status; once, with the notices of that. Whether it is still `Pending`. */
  markSentByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    recipients: PauseRecipients,
  ): Promise<boolean> {
    return this.connection.inTransaction(async (transaction) => {
      const { session } = transaction;
      const found = await this.pauses.findOne({ _id: pauseIdOf(tenantId, pauseId) }, { session });
      if (found === null) return false;
      const change = markSentChange(pauseOfDocument(found), recipients);
      if (!found.isSent) {
        const sent = { _id: found._id, isSent: false };
        const marked = await this.pauses.updateOne(
          sent,
          { $set: fieldsOf(change.pause) },
          { session },
        );
        // one snapshot with the read: a miss is the driver's conflict, so this fails closed (a test
        // makes it miss: pause-sent-mark.test.ts)
        if (marked.matchedCount !== 1) throw new Error("the sent mark matched no pause");
        await this.appendNotices(transaction, change.pause, change.notices);
      }
      return change.pause.status === PauseStatus.Pending;
    });
  }

  resolveByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return this.change(tenantId, pauseId, this.guards.open(at), (before) =>
      resolveChange(before, answer, at, recipients),
    );
  }

  /** Its channel decided at once: `Pending → Taken`, no notice (the pause was never sent). */
  async decideByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<boolean> {
    const closing = JSON.stringify({
      status: PauseStatus.Taken,
      resolution: PauseResolution.Decided,
      resolvedAt: at.toISOString(),
      answer,
    });
    const decided = await this.pauses.updateOne(
      { _id: pauseIdOf(tenantId, pauseId), status: PauseStatus.Pending },
      { $set: { status: PauseStatus.Taken, resolvedAt: at, closing } },
    );
    return decided.matchedCount === 1;
  }

  cancelByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseCancellation,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return this.change(tenantId, pauseId, this.guards.inStatus(PauseStatus.Pending), (before) =>
      cancelChange(before, resolution, at, recipients),
    );
  }

  expireByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    expiry: PauseExpiry,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return this.change(tenantId, pauseId, this.guards.due(at), (before) =>
      expireChange(before, expiry, at, recipients),
    );
  }

  closeUntakenByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseUntakenResolution,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return this.change(tenantId, pauseId, this.guards.inStatus(PauseStatus.Resolved), (before) =>
      closeUntakenChange(before, resolution, at, recipients),
    );
  }

  extendByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    change: PauseDeadlineChange,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    const dates = {
      previous: new Date(change.previousExpiresAt),
      next: new Date(change.expiresAt),
    };
    return this.change(tenantId, pauseId, this.guards.extendable(at, dates), (before) =>
      extendChange(before, change, at, recipients),
    );
  }

  reassignByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    replacement: PauseReplacement,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return reassignIn(this.#parts(), { tenantId, pauseId }, replacement, at, recipients);
  }

  /** What the transactions that live in their own files need of this store. */
  #parts(): PauseParts {
    return {
      connection: this.connection,
      pauses: this.pauses,
      guards: this.guards,
      appendNotices: (...args) => this.appendNotices(...args),
    };
  }

  async remindByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<boolean> {
    const reminded = await this.change(tenantId, pauseId, this.guards.remindable(at), (before) =>
      remindChange(before, at, recipients),
    );
    return reminded !== undefined;
  }

  /**
   * Once per kind, in any status, only for a sent pause: in one transaction, never relying on a
   * duplicate-key error (an `E11000` inside a transaction aborts it). (1) the pause is read, sent;
   * (2) none of its mailboxes has a notice of the kind; (3) the append, an upsert by `_id` — and a
   * write to the pause, so a retention's delete of it conflicts. Two calls at once: the loser's
   * transaction is a write conflict, run again, and it finds step 2's notice.
   */
  noticeOnceByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    kind: PauseNoticeKind,
    facts: PauseNoticeFacts,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<boolean> {
    return noticeOnceIn(this.#parts(), { tenantId, pauseId }, { kind, facts }, at, recipients);
  }

  async markTakenByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<void> {
    await this.pauses.updateOne(
      { _id: pauseIdOf(tenantId, pauseId), status: PauseStatus.Resolved },
      { $set: { status: PauseStatus.Taken } },
    );
  }
}
