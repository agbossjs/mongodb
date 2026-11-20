import { StoreOutcomeSource, StoreOutcomeUnknownError } from "@agboss/core/stores";
import { MongoBulkWriteError, MongoServerError, MongoWriteConcernError } from "mongodb";

/**
 * Which errors of a write leave its outcome unknown (agbossjs/agboss#1017, mirroring
 * `@agboss/postgres`'s `outcome.ts`) — by WHITELIST: only an error that proves the write was NOT
 * applied is known; every other error after the send is `StoreOutcomeUnknownError`, a wrong
 * "unknown" costs one hand-over, a wrong "known" undoes an order whose charge was taken. The driver
 * already retries what it can (a retryable write and a `commitTransaction` are sent once more after
 * a lost reply), so what reaches the store is after that.
 *
 * Known is the server's own error reply that proves nothing was applied (`KNOWN_CODES`: a duplicate
 * key, a document validation failure, a write conflict, a refusal of the command's form, ...), a
 * `MongoBulkWriteError` whose every per-operation error is such a reply and none of whose
 * operations succeeded.
 * A commit is never known (`commitErrorOf`: the driver retries it by itself, so the error seen may
 * be the retry's after a first attempt that was sent). Unknown is everything else: a transport error or timeout, a pool or selection error (the driver's
 * retry may have followed a sent first attempt), a write concern error (the write may have been
 * applied), `NotWritablePrimary` and every other code after the send, a bulk write that failed as
 * a whole, an error with no code, an error of a kind not listed.
 *
 * An unknown outcome is `StoreOutcomeUnknownError`, source `Transport`: under a lease the holder
 * hands the tree over, and the next holder finds what the write left.
 */

/**
 * The server's refusals of a command's FORM, made before anything runs: BadValue 2, FailedToParse 9,
 * TypeMismatch 14, ConflictingUpdateOperators 40. Known for every write, a multi-document one too.
 */
const REFUSED_BEFORE_RUNNING: ReadonlySet<number> = new Set([2, 9, 14, 40]);

/**
 * The server's replies about ONE document, which prove a write of one document did nothing: a
 * duplicate key 11000, 11001 and 12582, a document validation failure 121, a write conflict 112.
 * Not for a multi-document write (`updateMany`, `deleteMany`) outside a transaction: it is not
 * atomic, the documents before the failing one stay written. Not `NoSuchTransaction` 251 or
 * `Unauthorized` 13: under `retryWrites` the retry of a write that was applied can be answered with
 * them (the session's state, a revoked role), so they prove nothing.
 */
const REFUSED_PER_DOCUMENT: ReadonlySet<number> = new Set([112, 121, 11000, 11001, 12582]);

/** A code that is no number is in no set of numbers: the whitelist reads as numbers only. */
const isIn = (codes: ReadonlySet<unknown>, code: unknown): boolean => codes.has(code);

/**
 * Whether `error` is the server's reply that proves the write was not applied; `isMulti`: a write
 * of many documents, whose per-document replies prove nothing.
 */
function provesNotApplied(error: unknown, isMulti: boolean): boolean {
  // a write concern error is a MongoServerError too: the write may have been applied
  if (error instanceof MongoWriteConcernError) return false;
  const knownCode = (code: unknown): boolean =>
    isIn(REFUSED_BEFORE_RUNNING, code) || (!isMulti && isIn(REFUSED_PER_DOCUMENT, code));
  if (error instanceof MongoBulkWriteError) {
    const failed = [error.writeErrors].flat();
    const applied =
      error.insertedCount + error.matchedCount + error.upsertedCount + error.deletedCount;
    // a batch that also met a write concern error (this one's, or another command's) may have applied
    const concern = error.err !== undefined || error.result.getWriteConcernError() !== undefined;
    const known = (code: unknown): boolean =>
      isIn(REFUSED_BEFORE_RUNNING, code) || isIn(REFUSED_PER_DOCUMENT, code);
    return !concern && failed.length > 0 && applied === 0 && failed.every((one) => known(one.code));
  }
  return error instanceof MongoServerError && knownCode(error.code);
}

const STORE = "MongoConnection";

const unknown = (operation: string, cause: unknown): StoreOutcomeUnknownError =>
  new StoreOutcomeUnknownError({
    store: STORE,
    operation,
    source: StoreOutcomeSource.Transport,
    cause,
  });

/**
 * The error of a commit the driver gave up on: ALWAYS unknown. The driver sends a commit again by
 * itself (`commitTransaction`, and the operation's own retry), and what reaches this code is the
 * LAST attempt's error — the first may have been sent and committed. So no reply proves non-
 * application: not `NoSuchTransaction` (251) or a transient label (the retry of a committed
 * transaction can be answered with them), not a transport error, not a write concern error.
 */
export function commitErrorOf(error: unknown): StoreOutcomeUnknownError {
  return error instanceof StoreOutcomeUnknownError ? error : unknown("commitTransaction", error);
}

/** `error` of a single-command write (`isMulti`: of many documents): as it is when the server proved nothing was applied, else unknown. */
export function writeErrorOf(operation: string, error: unknown, isMulti = false): unknown {
  if (error instanceof StoreOutcomeUnknownError || provesNotApplied(error, isMulti)) return error;
  return unknown(operation, error);
}

/** `run`, a single-command write: an error that does not prove the write unapplied is read as unknown. */
export async function settled<TResult>(
  operation: string,
  run: () => Promise<TResult>,
): Promise<TResult> {
  try {
    return await run();
  } catch (error) {
    throw writeErrorOf(operation, error);
  }
}
