import type { PauseRecord } from "@agboss/core";
import type { PauseReassignmentChange, PauseRecipients } from "@agboss/core/stores";
import type { Collection } from "mongodb";
import type { MongoConnection } from "../../connection/mongodb-connection.js";
import type { MongoTransaction } from "../../connection/transaction.js";
import type { PlannedNotice } from "./pause-changes.js";
import {
  insertPause,
  pauseIdOf,
  pauseOfDocument,
  writtenFieldsOf,
  type PauseDocument,
} from "./pause-documents.js";
import type { PauseGuards } from "./pause-guards.js";
import { reassignChange } from "./pause-reassign-plan.js";

/** What a transaction of the pause store needs of it: its connection, collection, guards and notice writer. */
export interface PauseParts {
  readonly connection: MongoConnection;
  readonly pauses: Collection<PauseDocument>;
  readonly guards: PauseGuards;
  readonly appendNotices: (
    transaction: MongoTransaction,
    pause: PauseRecord,
    notices: readonly PlannedNotice[],
  ) => Promise<void>;
}

/**
 * One transaction (#946): the old pause read, its replacement planned, the old pause closed by the
 * compare-and-set of an answer's — pending, its deadline after `at` in the filter — and the
 * replacement inserted with the old pause's `closed` notice. Of two racing reassignments, or a
 * reassignment and an answer, one writes the old pause and the other's write conflicts, runs again
 * and finds it closed: `undefined`. The replacement's step key is read from the tree's step keys in
 * the same snapshot, and a pause another transaction inserts under the same key conflicts too.
 */
export function reassignIn(
  parts: PauseParts,
  target: { readonly tenantId: string; readonly pauseId: string },
  replacement: PauseReassignmentChange,
  at: Date,
  recipients: PauseRecipients,
): Promise<PauseRecord | undefined> {
  const { tenantId, pauseId } = target;
  return parts.connection.inTransaction(async (transaction) => {
    const { db, session } = transaction;
    const _id = pauseIdOf(tenantId, pauseId);
    const found = await parts.pauses.findOne({ _id }, { session });
    if (found === null) return undefined;
    const before = pauseOfDocument(found);
    const siblings = await parts.pauses
      .find({ tenantId, rootExecutionId: before.rootExecutionId }, { session })
      .project<{ stepKey: string }>({ stepKey: 1 })
      .toArray();
    const taken = new Set(siblings.map((one) => one.stepKey));
    const change = reassignChange(before, replacement, taken, at, recipients);
    if (change === undefined) return undefined;
    const written = await parts.pauses.updateOne(
      { _id, ...(replacement.due === undefined ? parts.guards.open(at) : parts.guards.due(at)) },
      writtenFieldsOf(before, change.pause),
      { session },
    );
    if (written.matchedCount === 0) return undefined;
    await parts.appendNotices(transaction, change.pause, change.notices);
    // in place: the changed pause itself; otherwise the replacement is inserted
    if (change.inserted === undefined) return change.pause;
    await insertPause(db, session, change.inserted);
    return change.inserted;
  });
}
