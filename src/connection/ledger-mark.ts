import type { ClientSession, Db } from "mongodb";
import { z } from "zod";
import { MongoLedgerMarkMissingError } from "../errors.js";
import { Collections } from "./collections.js";

/**
 * The ledger's pruning mark (agbossjs/agboss#771): one document of `agboss_cost_entries`, its `_id`
 * `\u0000pruned-before` (`\u0000` never occurs in a `ledgerId`). It is seeded once, with the
 * collection (agbossjs/agboss#798) — so its absence never means "never pruned": a mark deleted by
 * hand is `MongoLedgerMarkMissingError` at every save and prune, never seeded again by a restart.
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

/** A duplicate key: another instance seeded the mark first. */
const isDuplicateKey = (error: unknown): boolean =>
  z.object({ code: z.literal(11000) }).safeParse(error).success;

/** Seeds the mark of a ledger whose entries' collection was just made (never over one). */
export async function seedLedgerMark(db: Db): Promise<void> {
  try {
    await marksOf(db).insertOne({ _id: LEDGER_MARK_ID, prunedBefore: NEVER_PRUNED });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
}

/** The mark in `session`, in ms; none → `MongoLedgerMarkMissingError`. */
export async function prunedBeforeOf(db: Db, session: ClientSession): Promise<number> {
  const found = await marksOf(db).findOne({ _id: LEDGER_MARK_ID }, { session });
  if (found === null) throw new MongoLedgerMarkMissingError();
  return Mark.parse(found).prunedBefore.getTime();
}

/** The mark raised to `cutoff` (never lowered) in `session`: its value; none → the error. */
export async function raisedLedgerMark(
  db: Db,
  cutoff: Date,
  session: ClientSession,
): Promise<Date> {
  const mark = await marksOf(db).findOneAndUpdate(
    { _id: LEDGER_MARK_ID },
    { $max: { prunedBefore: cutoff } },
    { session, returnDocument: "after" },
  );
  if (mark === null) throw new MongoLedgerMarkMissingError();
  return Mark.parse(mark).prunedBefore;
}
