import { Clock, Injectable, PauseStatus, type PauseRecord } from "@agboss/core";
import type {
  PauseFilter,
  PauseNoticeClaim,
  PauseNoticeCounts,
  PausePage,
  PauseScanAfter,
  SetAsideMailbox,
} from "@agboss/core/stores";
import type { Milliseconds } from "@agboss/core/units";
import { Collections } from "../connection/collections.js";
import { fillMissingChannels } from "../connection/pause-channels.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import {
  acknowledge,
  claimDue,
  countMailboxes,
  giveUp,
  renew,
  retry,
  setAsideStale,
} from "./paused/pause-delivery.js";
import { mailboxesOf } from "./paused/pause-mailboxes.js";
import type { PauseDocument } from "./paused/pause-documents.js";
import {
  assertPauseFilter,
  assertScanLimit,
  dueBy,
  pageOf,
  reassignedUnsentBefore,
  removableBefore,
  removablePageBefore,
  tenantFilter,
} from "./paused/pause-scans.js";
import { MongoPauseTransitions } from "./paused/pause-transitions.repository.js";

/** What the retention removes per transaction. */
const RETENTION_BATCH = 500;

/**
 * `PausedExecutionRepository` on MongoDB (#265, #267 S35, #910 contract v2, #938,
 * agbossjs/agboss#527): one document per thread of a tenant — the paused run and the versions it
 * paused under — one per pause, and one mailbox per pause and receiver (`agboss_pause_notices`).
 * Every transition of a pause is one compare-and-set in a transaction with the notices it writes
 * (`MongoPauseBase.change`), the deadline in the filter, so of two instances exactly one records
 * it; the claims, acknowledgements and set-asides of the notices are one conditional command on one
 * mailbox. The scans' cursor is the insertion sequence (a counter that only grows). With
 * `MongoCheckpointSaver` a pause made on one instance is resumed on any.
 */
@Injectable({ deps: [MongoConnection, Clock] })
export class MongoPausedExecutionRepository extends MongoPauseTransitions {
  async findPendingByExpiresAtBefore(
    at: Date,
    limit: number,
    after?: PauseScanAfter,
  ): Promise<readonly PauseRecord[]> {
    assertScanLimit(limit);
    return dueBy(this.connection.db, "expiresAt", at, limit, after);
  }

  async findPendingByRemindAtBefore(
    at: Date,
    limit: number,
    after?: PauseScanAfter,
  ): Promise<readonly PauseRecord[]> {
    assertScanLimit(limit);
    return dueBy(this.connection.db, "remindAt", at, limit, after);
  }

  async findPendingUnsentReassignedBefore(
    cutoff: Date,
    limit: number,
    after?: PauseScanAfter,
  ): Promise<readonly PauseRecord[]> {
    assertScanLimit(limit);
    return reassignedUnsentBefore(this.connection.db, cutoff, limit, after);
  }

  async findOpenAfter(after: string | undefined, limit: number): Promise<PausePage> {
    assertScanLimit(limit);
    const open = { status: { $in: [PauseStatus.Pending, PauseStatus.Resolved] } };
    return pageOf(this.connection.db, open, limit, after);
  }

  async findPageByTenantId(
    tenantId: string,
    filter: PauseFilter,
    limit: number,
    after?: string,
  ): Promise<PausePage> {
    assertScanLimit(limit);
    assertPauseFilter(filter);
    // a pause an old instance wrote after the migration has no channel: it is given one here (#1104)
    if (filter.channel !== undefined) await fillMissingChannels(this.connection.db, { tenantId });
    return pageOf(this.connection.db, tenantFilter(tenantId, filter), limit, after);
  }

  async findClosedByResolvedAtBefore(
    cutoff: Date,
    limit: number,
    after?: string,
  ): Promise<PausePage> {
    assertScanLimit(limit);
    return removablePageBefore(this.connection.db, cutoff, limit, after);
  }

  /** Removes the closed pauses before `cutoff` with no live mailbox, and their mailboxes, a batch per transaction. */
  async deleteByResolvedAtBefore(cutoff: Date): Promise<void> {
    // what this sweep removed: a reassigned pause whose replacement went in the same sweep stays for
    // the next one, so a chain is removed oldest first (#946)
    const removedByThisSweep = new Set<string>();
    for (;;) {
      const removed = await this.connection.inTransaction(async ({ db, session }) => {
        const batch = await removableBefore(
          db,
          cutoff,
          RETENTION_BATCH,
          session,
          undefined,
          removedByThisSweep,
        );
        if (batch.length === 0) return [];
        const ids = batch.map((one) => one._id);
        await db
          .collection<PauseDocument>(Collections.Pauses)
          .deleteMany({ _id: { $in: ids } }, { session });
        const sites = batch.map(({ tenantId, pauseId }) => ({ tenantId, pauseId }));
        await mailboxesOf(db).deleteMany({ $or: sites }, { session });
        return ids;
      });
      if (removed.length === 0) return;
      for (const id of removed) removedByThisSweep.add(id);
    }
  }

  claimNoticesDue(
    at: Date,
    limit: number,
    claimFor: Milliseconds,
    recipients: readonly string[],
  ): Promise<readonly PauseNoticeClaim[]> {
    return Promise.resolve().then(() => {
      assertScanLimit(limit);
      return claimDue(this.connection.db, at, limit, claimFor, recipients);
    });
  }

  ackNotice(claim: PauseNoticeClaim, at: Date): Promise<PauseNoticeClaim | undefined> {
    return acknowledge(this.connection.db, claim, at);
  }

  renewNotice(
    claim: PauseNoticeClaim,
    at: Date,
    claimFor: Milliseconds,
  ): Promise<PauseNoticeClaim | undefined> {
    return renew(this.connection.db, claim, at, claimFor);
  }

  retryNotice(claim: PauseNoticeClaim, nextAttemptAt: Date, problem: string): Promise<boolean> {
    return retry(this.connection.db, claim, nextAttemptAt, problem);
  }

  setAsideNotices(claim: PauseNoticeClaim, _at: Date, problem: string): Promise<boolean> {
    return giveUp(this.connection.db, claim, problem);
  }

  setAsideStaleNoticesBefore(
    writtenBefore: Date,
    at: Date,
    problem: string,
    limit: number,
  ): Promise<readonly SetAsideMailbox[]> {
    return Promise.resolve().then(() => {
      assertScanLimit(limit);
      return setAsideStale(this.connection.db, writtenBefore, at, problem, limit);
    });
  }

  countNotices(): Promise<PauseNoticeCounts> {
    return countMailboxes(this.connection.db);
  }
}
