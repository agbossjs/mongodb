import type { ClientSession, Db } from "mongodb";
import { z } from "zod";
import { MongoLedgerMarkMissingError } from "../errors.js";
import { Collections } from "./collections.js";

/**
 * The ledger's pruning mark (agbossjs/agboss#771): one document of `agboss_cost_entries`, its `_id`
 * `\u0000pruned-before` (`\u0000` never occurs in a `ledgerId`). It is made with the collection, in
 * the transaction that creates it (agbossjs/agboss#798) — the collection never exists without it —
 * so its absence never means "never pruned": a mark deleted by hand, or one whose `prunedBefore` is
 * not a date, is `MongoLedgerMarkMissingError` at every save and prune, and a restart never seeds it.
 */
export const LEDGER_MARK_ID = "\u0000pruned-before";

/** The seeded mark: nothing pruned yet. */
const NEVER_PRUNED = new Date(0);

interface MarkDocument {
  _id: string;
  prunedBefore: Date;
}

const Mark = z.object({ prunedBefore: z.date() });

const marksOf = (db: Db) => db.collection<MarkDocument>(Collections.CostEntries);

const hasCode = (error: unknown, code: number): boolean =>
  z.object({ code: z.literal(code) }).safeParse(error).success;

/**
 * Creates `agboss_cost_entries` (the simple collation) with its mark, in one transaction: another
 * instance's create of it in between is `NamespaceExists`, the collection there with its mark.
 */
export async function createLedgerEntries(db: Db): Promise<void> {
  const session = db.client.startSession();
  try {
    // a create in a transaction takes read concern local; it reads nothing
    await session.withTransaction(
      async () => {
        await db.createCollection(Collections.CostEntries, {
          collation: { locale: "simple" },
          session,
        });
        await marksOf(db).insertOne(
          { _id: LEDGER_MARK_ID, prunedBefore: NEVER_PRUNED },
          { session },
        );
      },
      { readConcern: { level: "local" }, writeConcern: { w: "majority", journal: true } },
    );
  } catch (error) {
    if (!hasCode(error, 48)) throw error;
  } finally {
    await session.endSession();
  }
}

/** Seeds the mark of an emptied ledger (a test's reset), never over one. */
export async function seedLedgerMark(db: Db): Promise<void> {
  try {
    await marksOf(db).insertOne({ _id: LEDGER_MARK_ID, prunedBefore: NEVER_PRUNED });
  } catch (error) {
    if (!hasCode(error, 11000)) throw error;
  }
}

/** The mark's value, or the error naming what was found instead (none, or not a date). */
function prunedBeforeIn(found: unknown): Date {
  if (found === null || found === undefined) throw new MongoLedgerMarkMissingError();
  const parsed = Mark.safeParse(found);
  if (!parsed.success) throw new MongoLedgerMarkMissingError({ malformed: true });
  return parsed.data.prunedBefore;
}

/** The mark in `session`; none or not a date → `MongoLedgerMarkMissingError`. */
export async function prunedBeforeOf(db: Db, session: ClientSession): Promise<Date> {
  const found = await marksOf(db).findOne({ _id: LEDGER_MARK_ID }, { session });
  return prunedBeforeIn(found);
}

/**
 * The mark raised to `cutoff` (never lowered) in `session`: its value. Only a mark that is a date
 * is raised — `$max` would replace a missing or non-date `prunedBefore` with the cutoff, lowering a
 * mark an operator wrote as a number — so none or not a date → `MongoLedgerMarkMissingError`.
 */
export async function raisedLedgerMark(
  db: Db,
  cutoff: Date,
  session: ClientSession,
): Promise<Date> {
  const mark = await marksOf(db).findOneAndUpdate(
    { _id: LEDGER_MARK_ID, prunedBefore: { $type: "date" } },
    { $max: { prunedBefore: cutoff } },
    { session, returnDocument: "after" },
  );
  if (mark !== null) return prunedBeforeIn(mark);
  return prunedBeforeIn(await marksOf(db).findOne({ _id: LEDGER_MARK_ID }, { session }));
}
