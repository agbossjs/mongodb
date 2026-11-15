import { StoreOutcomeSource, StoreOutcomeUnknownError } from "@agboss/core/stores";
import { MongoError, MongoNetworkError, MongoWriteConcernError } from "mongodb";

/**
 * Which errors of a write leave its outcome unknown (agbossjs/agboss#1017, mirroring
 * `@agboss/postgres`'s `outcome.ts`). The driver already retries what it can: a retryable write and a
 * `commitTransaction` are sent once more after a lost reply (the server answers the same command
 * again from its transaction number), so after ONE reset the retry learns the real outcome and
 * nothing is unknown. What reaches the store after the driver's retries is what is:
 *
 * - a commit that still carries `UnknownTransactionCommitResult` (the retry's reply lost too, or a
 *   write concern error), or fails as a transport error: the transaction may have committed;
 * - a single-command write that still fails as a transport error (`MongoNetworkError`) or with a
 *   write concern error (`MongoWriteConcernError`: applied, not acknowledged by a majority);
 * - any other error — the server's own answer (a write conflict, a duplicate key, a refusal), the
 *   work's own — is known: rethrown as it is. A `TransientTransactionError` is the driver's to run
 *   again.
 *
 * An unknown outcome is `StoreOutcomeUnknownError`, source `Transport`: under a lease the holder
 * hands the tree over, and the next holder finds what the write left.
 */

const STORE = "MongoConnection";

const hasLabel = (error: unknown, label: string): boolean =>
  error instanceof MongoError && error.hasErrorLabel(label);

const unknown = (operation: string, cause: unknown): StoreOutcomeUnknownError =>
  new StoreOutcomeUnknownError({
    store: STORE,
    operation,
    source: StoreOutcomeSource.Transport,
    cause,
  });

/** The error of a commit the driver gave up on: unknown, or as it is (a transient one is the driver's). */
export function commitErrorOf(error: unknown): unknown {
  if (hasLabel(error, "TransientTransactionError")) return error;
  if (hasLabel(error, "UnknownTransactionCommitResult") || error instanceof MongoNetworkError)
    return unknown("commitTransaction", error);
  return error;
}

/** `error` of a single-command write, as the error of unknown outcome it is read as, or as it is. */
export function writeErrorOf(operation: string, error: unknown): unknown {
  if (error instanceof MongoNetworkError || error instanceof MongoWriteConcernError)
    return unknown(operation, error);
  return error;
}

/** `run`, a single-command write: an error that leaves its outcome unknown is read as one. */
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
