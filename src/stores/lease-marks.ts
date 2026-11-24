import {
  InterruptMode,
  type NewStatusTransition,
  type PauseMarks,
  type PauseRequest,
  type StoreClock,
  type TreeMarks,
} from "@agboss/core";
import type { ExecutionTree } from "@agboss/core/stores";
import type { ClientSession, Db, Document } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";
import type { MongoConnection } from "../connection/mongodb-connection.js";
import { settled } from "../connection/outcome.js";
import { orSeed, seedStages } from "./lease-seed.js";
import { treeIdOf } from "./keys.js";
import type { LeaseDocument } from "./lease-documents.js";
import { appendStatus } from "./status-log.js";
import { literal, storeNowOf } from "./store-time.js";

/**
 * The stop and pause marks of a tree on MongoDB (agbossjs/agboss#1341b, #1341c): fields of the
 * tree's own lease document (`stopRequestedAt`, `stopMode`, `isExternallyPaused`,
 * `externalPauseReason`, `externalPauseMode`, `fencedThroughToken`), written with the thread's
 * history document in ONE transaction (the database's document is the authority, D6). A tree with
 * no document gets a seed document (token 0, released, never held).
 *
 * Every mark is ONE update of the lease document — an update pipeline run by the server on the
 * document as it is, upserting it: no value is read by the client and written back, so two
 * concurrent writers cannot weaken a mark (a lost update):
 *
 * - `stopMode` and `externalPauseMode` only escalate: `immediate` stays `immediate` whatever
 *   order two requests arrive in (`$cond` on the stored value, in the server);
 * - `fencedThroughToken` only rises (`$max`) and is never cleared, nor is `cancelRequestedAt`;
 * - the times of a first request (`stopRequestedAt`) are set only when absent (`$ifNull`).
 *
 * The update answers the document as it was (`returnDocument: "before"`, the same atomic command):
 * that is what says whether this call set or escalated the mark, and so whether it writes a history
 * document. A write that carries a history document runs in a transaction, so both or neither.
 */

type Tree = Pick<ExecutionTree, "tenantId" | "rootExecutionId">;

const leasesOf = (db: Db) => db.collection<LeaseDocument & Document>(Collections.ExecutionLeases);

/** What a mark's update runs on: the database, and the session of the transaction when it has one. */
export interface MarkScope {
  readonly db: Db;
  readonly session?: ClientSession | undefined;
}

/** The clock and the history document a mark writes. */
export interface MarkWrite {
  readonly clock: StoreClock;
  readonly transition?: NewStatusTransition | undefined;
}

/**
 * Runs `run` as one mark: in a transaction when the mark carries a history document (both or
 * neither), else as the one single-document command it is — an unknown outcome read as such.
 */
export function marked<TResult>(
  connection: MongoConnection,
  write: MarkWrite,
  operation: string,
  run: (scope: MarkScope) => Promise<TResult>,
): Promise<TResult> {
  if (write.transition === undefined) return settled(operation, () => run({ db: connection.db }));
  return connection.inTransaction(({ db, session }) => run({ db, session }));
}

/** The history document of a mark, in the mark's transaction. */
export async function logged(scope: MarkScope, write: MarkWrite): Promise<void> {
  if (write.transition !== undefined && scope.session !== undefined)
    await appendStatus(scope.db, scope.session, write.transition, write.clock.now());
}

/** A mark's update: seeds the document, then sets the mark's own fields; answers the document as it was. */
async function updated(scope: MarkScope, tree: Tree, stage: Document): Promise<Document | null> {
  return leasesOf(scope.db).findOneAndUpdate(
    { _id: treeIdOf(tree.tenantId, tree.rootExecutionId) },
    [...seedStages(tree), stage],
    {
      upsert: true,
      returnDocument: "before",
      ...(scope.session === undefined ? {} : { session: scope.session }),
    },
  );
}

const IMMEDIATE = InterruptMode.Immediate;

/**
 * Marks the stop: once, escalated from `after-step` to `immediate`, never lowered — one update; the
 * history document only when this call set or escalated the mark.
 */
export async function markStop(
  scope: MarkScope,
  tree: Tree,
  mode: InterruptMode,
  write: MarkWrite,
): Promise<void> {
  const before = await updated(scope, tree, {
    $set: {
      stopRequestedAt: orSeed("stopRequestedAt", storeNowOf(write.clock)),
      stopMode: {
        $cond: [
          { $or: [{ $eq: ["$stopMode", IMMEDIATE] }, { $eq: [literal(mode), IMMEDIATE] }] },
          IMMEDIATE,
          literal(mode),
        ],
      },
    },
  });
  const previous = Before.parse(before ?? {}).stopMode;
  const isEscalated = previous === InterruptMode.AfterStep && mode === IMMEDIATE;
  if (previous === undefined || isEscalated) await logged(scope, write);
}

/**
 * Marks the tree paused from outside (`requestPause`) in one update: `immediate` stays `immediate`
 * while paused, the fence rises to the lease's token (`$max`) for an `Immediate` request and is
 * never lowered; the history document only when the tree was not paused already.
 */
export async function markPause(
  scope: MarkScope,
  tree: Tree,
  request: PauseRequest,
  write: MarkWrite,
): Promise<void> {
  const { reason, mode } = request;
  const isImmediate = mode === IMMEDIATE;
  const before = await updated(scope, tree, {
    $set: {
      isExternallyPaused: true,
      externalPauseReason: reason === undefined ? "$$REMOVE" : literal(reason),
      externalPauseMode: {
        $cond: [
          {
            $and: [
              { $eq: [{ $ifNull: ["$isExternallyPaused", false] }, true] },
              { $eq: ["$externalPauseMode", IMMEDIATE] },
            ],
          },
          IMMEDIATE,
          literal(mode),
        ],
      },
      fencedThroughToken: isImmediate
        ? { $max: [{ $ifNull: ["$fencedThroughToken", 0] }, "$token"] }
        : "$fencedThroughToken",
    },
  });
  if (Before.parse(before ?? {}).isExternallyPaused !== true) await logged(scope, write);
}

/** Lifts the pause in one update; the fence stays. The history document only when a pause was lifted. */
export async function liftPause(scope: MarkScope, tree: Tree, write: MarkWrite): Promise<void> {
  const lifted = await leasesOf(scope.db).updateOne(
    { _id: treeIdOf(tree.tenantId, tree.rootExecutionId), isExternallyPaused: true },
    {
      $set: { isExternallyPaused: false },
      $unset: { externalPauseReason: "", externalPauseMode: "" },
    },
    scope.session === undefined ? {} : { session: scope.session },
  );
  if (lifted.modifiedCount === 1) await logged(scope, write);
}

const Before = z.object({
  stopMode: z.enum(InterruptMode).optional(),
  isExternallyPaused: z.boolean().optional(),
});

const Marks = z.object({
  cancelRequestedAt: z.date().optional(),
  stopMode: z.enum(InterruptMode).optional(),
  isExternallyPaused: z.boolean().optional(),
  externalPauseReason: z.string().optional(),
  externalPauseMode: z.enum(InterruptMode).optional(),
  fencedThroughToken: z.number().int().optional(),
});

/** The fields the marks read. */
const MARK_FIELDS = {
  cancelRequestedAt: 1,
  stopMode: 1,
  isExternallyPaused: 1,
  externalPauseReason: 1,
  externalPauseMode: 1,
  fencedThroughToken: 1,
} as const;

const pauseOf = (marks: z.infer<typeof Marks>): PauseMarks => ({
  ...(marks.isExternallyPaused === true
    ? {
        pause: {
          ...(marks.externalPauseReason === undefined ? {} : { reason: marks.externalPauseReason }),
          mode:
            marks.externalPauseMode === InterruptMode.Immediate
              ? InterruptMode.Immediate
              : InterruptMode.AfterStep,
        },
      }
    : {}),
  ...(marks.fencedThroughToken === undefined
    ? {}
    : { fencedThroughToken: marks.fencedThroughToken }),
});

/** Both marks and the pause of the tree's lease document, in one read. */
export async function marksOf(db: Db, tree: Tree): Promise<TreeMarks> {
  const found = await leasesOf(db).findOne(
    { _id: treeIdOf(tree.tenantId, tree.rootExecutionId) },
    { projection: MARK_FIELDS },
  );
  if (found === null) return { isCancelRequested: false };
  const marks = Marks.parse(found);
  return {
    isCancelRequested: marks.cancelRequestedAt !== undefined,
    ...(marks.stopMode === undefined ? {} : { stop: { mode: marks.stopMode } }),
    ...pauseOf(marks),
  };
}

/** The tree's external pause and its fence. */
export async function pauseMarksOf(db: Db, tree: Tree): Promise<PauseMarks> {
  const marks = await marksOf(db, tree);
  return {
    ...(marks.pause === undefined ? {} : { pause: marks.pause }),
    ...(marks.fencedThroughToken === undefined
      ? {}
      : { fencedThroughToken: marks.fencedThroughToken }),
  };
}
