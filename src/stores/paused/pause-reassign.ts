import { PauseResolution, PauseStatus, type PauseRecord } from "@agboss/core";
import {
  replacementStepKeyOf,
  type PauseRecipients,
  type PauseReplacement,
} from "@agboss/core/stores";
import type { Collection } from "mongodb";
import type { MongoConnection } from "../../connection/mongodb-connection.js";
import type { MongoTransaction } from "../../connection/transaction.js";
import { closed, closing, type PauseChange, type PlannedNotice } from "./pause-changes.js";
import {
  fieldsOf,
  insertPause,
  pauseIdOf,
  pauseOfDocument,
  type PauseDocument,
} from "./pause-documents.js";
import type { PauseGuards } from "./pause-guards.js";

/** A reassignment's change: the old pause closed, and the replacement it is replaced by (#946). */
interface ReassignChange extends PauseChange {
  readonly inserted: PauseRecord;
}

/**
 * `Pending → Cancelled / Reassigned` and the replacement made (#946), while the pause is open at
 * `at`: no deadline, or one after it (the guard decides it again in the write). The replacement is a
 * copy of the old pause — its deadline, `expiryBound`, `boundAt`, `remindAt`, `branchKeys`, `kind`
 * and `ask` —, `Pending` and unsent, for `replacement.assignee`, `askedAt = at`, `reassignedFrom` the
 * old id, its step key the next free `~r<n>` of the step's own among `takenStepKeys` (the tree's).
 */
export function reassignChange(
  before: PauseRecord,
  replacement: PauseReplacement,
  takenStepKeys: ReadonlySet<string>,
  at: Date,
  recipients: PauseRecipients,
): ReassignChange | undefined {
  const isOpen =
    before.status === PauseStatus.Pending &&
    (before.expiresAt === undefined || before.expiresAt > at.toISOString());
  if (!isOpen) return undefined;
  const after = closed(
    before,
    {
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Reassigned,
      reassignedTo: replacement.pauseId,
    },
    at,
  );
  const inserted: PauseRecord = {
    ...before,
    ...replacement,
    stepKey: replacementStepKeyOf(before, takenStepKeys),
    status: PauseStatus.Pending,
    isSent: false,
    askedAt: at.toISOString(),
    reassignedFrom: before.pauseId,
  };
  return { ...closing(before, after, at, recipients), inserted };
}

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
  replacement: PauseReplacement,
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
      { _id, ...parts.guards.open(at) },
      { $set: fieldsOf(change.pause) },
      { session },
    );
    if (written.matchedCount === 0) return undefined;
    await parts.appendNotices(transaction, change.pause, change.notices);
    await insertPause(db, session, change.inserted);
    return change.inserted;
  });
}
