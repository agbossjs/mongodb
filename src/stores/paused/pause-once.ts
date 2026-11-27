import {
  assertValidInstant,
  onceNotices,
  type PauseNoticeFacts,
  type PauseNoticeKind,
  type PauseRecipients,
} from "@agboss/core/stores";
import { mailboxesOf } from "./pause-mailboxes.js";
import { pauseIdOf, pauseOfDocument } from "./pause-documents.js";
import type { PauseParts } from "./pause-reassign.js";

/**
 * `noticeOnce…` in one transaction (see `MongoPauseTransitions`): (1) the pause is read, sent (the
 * core's `onceNotices` plans it); (2) none of its mailboxes has a notice of the kind; (3) the append
 * — and a write to the pause, so a retention's delete of it conflicts. Two calls at once: the loser's
 * transaction is a write conflict, run again, and it finds step 2's notice. An Invalid Date in `at`
 * or the facts is refused first, whether or not the pause exists.
 */
export function noticeOnceIn(
  parts: PauseParts,
  target: { readonly tenantId: string; readonly pauseId: string },
  once: { readonly kind: PauseNoticeKind; readonly facts: PauseNoticeFacts },
  at: Date,
  recipients: PauseRecipients,
): Promise<boolean> {
  const { tenantId, pauseId } = target;
  return parts.connection.inTransaction(async (transaction) => {
    assertValidInstant(at, "at");
    assertValidInstant(once.facts.closedAt, "closedAt");
    assertValidInstant(once.facts.expiresAt, "expiresAt");
    assertValidInstant(once.facts.previousExpiresAt, "previousExpiresAt");
    // (refused whether or not the pause exists)
    const { db, session } = transaction;
    const found = await parts.pauses.findOne({ _id: pauseIdOf(tenantId, pauseId) }, { session });
    if (found === null) return false;
    const pause = pauseOfDocument(found);
    const planned = onceNotices(pause, once.kind, once.facts, at, recipients);
    if (planned.length === 0) return false;
    const written = await mailboxesOf(db).findOne(
      { tenantId, pauseId, "notices.kind": once.kind },
      { session },
    );
    if (written !== null) return false;
    await parts.pauses.updateOne({ _id: found._id }, { $inc: { noticeWrites: 1 } }, { session });
    await parts.appendNotices(transaction, pause, planned);
    return true;
  });
}
