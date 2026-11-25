import { PauseStatus } from "@agboss/core";
import type { PauseRecipients } from "@agboss/core/stores";
import { pauseIdOf, pauseOfDocument, writtenFieldsOf } from "./pause-documents.js";
import { markSentChange } from "./pause-marks.js";
import type { PauseParts } from "./pause-reassign.js";

/**
 * `markSent…` in one transaction (see `MongoPauseTransitions`): the pause is read, and — only when its
 * channel was not yet marked asked — marked (with the reference the channel's system gave it, also
 * on its newest chain-of-custody entry) and told to the listeners and, if it already closed, the
 * channel. Whether the pause is still `Pending`.
 */
export function markSentIn(
  parts: PauseParts,
  target: { readonly tenantId: string; readonly pauseId: string },
  recipients: PauseRecipients,
  externalRef: string | undefined,
): Promise<boolean> {
  const { tenantId, pauseId } = target;
  return parts.connection.inTransaction(async (transaction) => {
    const { session } = transaction;
    const found = await parts.pauses.findOne({ _id: pauseIdOf(tenantId, pauseId) }, { session });
    if (found === null) return false;
    const before = pauseOfDocument(found);
    const change = markSentChange(before, recipients, externalRef);
    if (!found.isSent) {
      const sent = { _id: found._id, isSent: false };
      const marked = await parts.pauses.updateOne(
        sent,
        { $set: writtenFieldsOf(before, change.pause) },
        { session },
      );
      // one snapshot with the read: a miss is the driver's conflict, so this fails closed (a test
      // makes it miss: pause-sent-mark.test.ts)
      if (marked.matchedCount !== 1) throw new Error("the sent mark matched no pause");
      await parts.appendNotices(transaction, change.pause, change.notices);
    }
    return change.pause.status === PauseStatus.Pending;
  });
}
