import { InterruptMode, type TurnOutcome } from "@agboss/core";
import { z } from "zod";
import { Collections } from "../../connection/collections.js";
import type { MongoConnection } from "../../connection/mongodb-connection.js";
import { treeIdOf } from "../keys.js";
import type { LeaseDocument } from "../lease-documents.js";
import { seedStages } from "../lease-seed.js";
import { completedIn, type CompleteWrite } from "./record-writes.js";
import type { RecordDocument } from "./record-documents.js";

/**
 * A finish conditional on its tree's marks (agbossjs/agboss#1341b): in the write's own transaction
 * the tree's lease document is written first (`fenceChecks` counted up — a real change every time,
 * never a no-op the server would skip without locking; seeded when there is none) and its marks read
 * after. A stop or cancel mark is one update of that document, outside a transaction or in its own:
 * it commits before the write — the finish is refused, nothing written — or the write conflicts with
 * it and runs again on a snapshot that holds the mark. A finish never lands over a mark.
 */

const Tree = z.object({ tenantId: z.string(), runId: z.string().nullish() });
const Marks = z.object({
  cancelRequestedAt: z.date().optional(),
  stopMode: z.enum(InterruptMode).optional(),
});

/** The finish's record, written like `complete` unless its tree carries a stop or cancel mark; whether it was written. */
export function completeUnlessInterrupted(
  connection: MongoConnection,
  id: string,
  outcome: TurnOutcome,
  write: Pick<CompleteWrite, "now" | "context">,
): Promise<boolean> {
  return connection.inTransaction(async ({ db, session }) => {
    const record = await db
      .collection<RecordDocument>(Collections.ExecutionRecords)
      .findOne({ _id: id }, { session, projection: { tenantId: 1, runId: 1 } });
    const tree = Tree.parse(record ?? { tenantId: "" });
    if (typeof tree.runId === "string") {
      const leases = db.collection<LeaseDocument>(Collections.ExecutionLeases);
      const root = { tenantId: tree.tenantId, rootExecutionId: tree.runId };
      const filter = { _id: treeIdOf(root.tenantId, root.rootExecutionId) };
      await leases.updateOne(
        filter,
        [
          ...seedStages(root),
          { $set: { fenceChecks: { $add: [{ $ifNull: ["$fenceChecks", 0] }, 1] } } },
        ],
        { upsert: true, session },
      );
      const marks = Marks.parse(await leases.findOne(filter, { session }));
      if (marks.cancelRequestedAt !== undefined || marks.stopMode !== undefined) return false;
    }
    return completedIn(db, session, id, outcome, write);
  });
}
