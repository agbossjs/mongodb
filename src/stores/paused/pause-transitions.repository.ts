import { PauseStatus, type PauseCancellation, type PauseRecord } from "@agboss/core";
import {
  assertValidInstant,
  cancelChange,
  closeUntakenChange,
  decideChange,
  expireChange,
  remindChange,
  resolveChange,
  timeoutChange,
  type PauseAnswer,
  type PauseExpiry,
  type PauseNoticeFacts,
  type PauseNoticeKind,
  type PauseReassignmentChange,
  type PauseRecipients,
  type PauseSeen,
  type PauseTimeoutChange,
  type PauseUntakenResolution,
} from "@agboss/core/stores";
import { MongoPauseBase } from "./pause-base.js";
import { findOrCreatePause, pauseIdOf, pauseOfDocument } from "./pause-documents.js";
import { markSentIn } from "./pause-sent.js";
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
    externalRef?: string,
  ): Promise<boolean> {
    return markSentIn(this.#parts(), { tenantId, pauseId }, recipients, externalRef);
  }

  resolveByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
    recipients: PauseRecipients,
    seen?: PauseSeen,
  ): Promise<PauseRecord | undefined> {
    return this.change(tenantId, pauseId, at, this.guards.open(at), (before) =>
      resolveChange(before, answer, at, recipients, seen),
    );
  }

  /**
   * Its channel decided at once: `Pending → Taken`, no notice (the pause was never sent) — only
   * while the deadline is after `at` (the guard) and the pause is still the one the channel was sent
   * (`seen`, compared over the record read in the same transaction as the write).
   */
  async decideByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
    seen: PauseSeen,
  ): Promise<boolean> {
    const decided = await this.change(tenantId, pauseId, at, this.guards.open(at), (before) =>
      decideChange(before, answer, at, seen),
    );
    return decided !== undefined;
  }

  cancelByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseCancellation,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return this.change(tenantId, pauseId, at, this.guards.inStatus(PauseStatus.Pending), (before) =>
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
    return this.change(tenantId, pauseId, at, this.guards.due(at), (before) =>
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
    return this.change(
      tenantId,
      pauseId,
      at,
      this.guards.inStatus(PauseStatus.Resolved),
      (before) => closeUntakenChange(before, resolution, at, recipients),
    );
  }

  /**
   * The deadline changed (`app.setPauseTimeout`, #1307): later, earlier, set or taken away — one
   * transaction. The filter decides that the pause is pending and open at `at` and that its stored
   * deadline is still `change.previousExpiresAt` (absent: none); the plan decides the pause as seen,
   * the new deadline after `at` or none, the record's cap and its `maxExtensions` count.
   */
  async changeTimeoutByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    change: PauseTimeoutChange,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    // refused before the read, whether or not the pause exists
    assertValidInstant(change.expiresAt, "expiresAt");
    assertValidInstant(change.remindAt, "remindAt");
    assertValidInstant(change.previousExpiresAt, "previousExpiresAt");
    return await this.change(
      tenantId,
      pauseId,
      at,
      this.guards.changeable(at, change.previousExpiresAt),
      (before) => timeoutChange(before, change, at, recipients),
    );
  }

  reassignByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    replacement: PauseReassignmentChange,
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
    const reminded = await this.change(
      tenantId,
      pauseId,
      at,
      this.guards.remindable(at),
      (before) => remindChange(before, at, recipients),
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
