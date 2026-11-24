import {
  PauseResolution,
  PauseStatus,
  type PauseRecord,
  type PauseTrailRecord,
} from "@agboss/core";
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

/** The entry a reassignment adds to the chain of custody: who moved the pause, when, to whom, why. */
function reassignedEntryOf(
  pause: PauseRecord,
  replacement: PauseReplacement,
  at: Date,
): PauseTrailRecord {
  const { assignees, actor, reason, due } = replacement;
  const expiresAt = due === undefined ? pause.expiresAt : due.expiresAt;
  return {
    action: "reassigned",
    at: at.toISOString(),
    ...(actor === undefined ? {} : { actor }),
    target: pause.channel,
    channel: pause.channel,
    assignees,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** The old pause without what a replacement does not keep: its reference, and on an expiry its deadline and reminder. */
function keptOf(pause: PauseRecord, isExpiry: boolean): PauseRecord {
  const dropped: readonly string[] = isExpiry
    ? ["externalRef", "expiresAt", "expiryBound", "remindAt"]
    : ["externalRef"];
  return Object.fromEntries(
    Object.entries(pause).filter(([key]) => !dropped.includes(key)),
  ) as PauseRecord;
}

/**
 * `Pending → Cancelled / Reassigned` and the replacement made (#946, #1310a), while the pause is
 * open at `at` — no deadline, or one after it — or, for an expiry's reassignment (`replacement.due`),
 * while its deadline is at or before `at` (the guard decides it again in the write). The
 * replacement is a copy of the old pause — its deadline, `expiryBound`, `boundAt`, `remindAt`,
 * `branchKeys`, `kind`, `input` and `toolCall`, unless an expiry made it: then `due` is its
 * deadline, with no reminder —, `Pending` and unsent, for `replacement.assignees`,
 * `askedAt = at`, `reassignedFrom` the old id, its step key the next free `~r<n>` of the step's own
 * among `takenStepKeys` (the tree's), its chain of custody the old one's and a `reassigned` entry
 * (who, why, to whom); the channel's `externalRef` is not kept. This restates the core's
 * `replacementPause`, which the stores entry does not export.
 */
export function reassignChange(
  before: PauseRecord,
  replacement: PauseReplacement,
  takenStepKeys: ReadonlySet<string>,
  at: Date,
  recipients: PauseRecipients,
): ReassignChange | undefined {
  const isApplicable =
    before.status === PauseStatus.Pending &&
    (replacement.due === undefined
      ? before.expiresAt === undefined || before.expiresAt > at.toISOString()
      : before.expiresAt !== undefined && before.expiresAt <= at.toISOString());
  if (!isApplicable) return undefined;
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
    ...keptOf(before, replacement.due !== undefined),
    ...replacement.due,
    pauseId: replacement.pauseId,
    assignees: replacement.assignees,
    stepKey: replacementStepKeyOf(before, takenStepKeys),
    status: PauseStatus.Pending,
    isSent: false,
    askedAt: at.toISOString(),
    reassignedFrom: before.pauseId,
    trail: [...before.trail, reassignedEntryOf(before, replacement, at)],
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
      { _id, ...(replacement.due === undefined ? parts.guards.open(at) : parts.guards.due(at)) },
      { $set: fieldsOf(change.pause) },
      { session },
    );
    if (written.matchedCount === 0) return undefined;
    await parts.appendNotices(transaction, change.pause, change.notices);
    await insertPause(db, session, change.inserted);
    return change.inserted;
  });
}
