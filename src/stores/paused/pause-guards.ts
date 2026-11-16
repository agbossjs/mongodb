import { PauseStatus } from "@agboss/core";
import type { Filter } from "mongodb";
import type { PauseDocument } from "./pause-documents.js";

/**
 * The conditions of every pause transition's compare-and-set (#938, #910 I1–I3): the filter of the
 * one write that records the change, so a transition that does not hold writes nothing, and the
 * deadline is judged in that write — never from a read that another instance may have outdated.
 */

/** A pending pause that takes an answer at `at`: no deadline, or one after it (I1, I2). */
export const openAt = (at: Date): Filter<PauseDocument> => ({
  status: PauseStatus.Pending,
  $or: [{ expiresAt: null }, { expiresAt: { $gt: at } }],
});

/** A pending pause whose deadline is at or before `at`. */
export const dueAt = (at: Date): Filter<PauseDocument> => ({
  status: PauseStatus.Pending,
  expiresAt: { $lte: at },
});

/**
 * What an extension moves (#1099, #1148): a pending pause whose stored deadline is still the one the
 * caller read (`previous`), after `at` (a write after the deadline is refused, the store's filter
 * deciding, never the caller's read), and earlier than the new one (a deadline never shortens).
 */
export const extendableAt = (
  at: Date,
  change: { readonly previous: Date; readonly next: Date },
): Filter<PauseDocument> => ({
  status: PauseStatus.Pending,
  $and: [{ expiresAt: { $eq: change.previous } }, { expiresAt: { $gt: at, $lt: change.next } }],
});

/** A pending pause whose reminder is due and whose deadline is after `at`: the reminder, once. */
export const remindableAt = (at: Date): Filter<PauseDocument> => ({
  status: PauseStatus.Pending,
  expiresAt: { $gt: at },
  remindAt: { $lte: at },
});

/** A pause that is still `status`: a cancel, or the closing of an answer no step took. */
export const inStatus = (status: PauseStatus): Filter<PauseDocument> => ({ status });

/** The five conditions as a store holds them: one place a broken store (a test's) replaces. */
export interface PauseGuards {
  open(at: Date): Filter<PauseDocument>;
  due(at: Date): Filter<PauseDocument>;
  extendable(
    at: Date,
    change: { readonly previous: Date; readonly next: Date },
  ): Filter<PauseDocument>;
  remindable(at: Date): Filter<PauseDocument>;
  inStatus(status: PauseStatus): Filter<PauseDocument>;
}

export const PAUSE_GUARDS: PauseGuards = {
  open: openAt,
  due: dueAt,
  extendable: extendableAt,
  remindable: remindableAt,
  inStatus,
};
