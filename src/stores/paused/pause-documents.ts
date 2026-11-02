import {
  PauseStatus,
  type PauseAnswer,
  type PauseRecord,
  type PauseResolution,
} from "@agboss/core";
import type { Collection, Db } from "mongodb";
import { z } from "zod";
import { Collections } from "../../connection/collections.js";
import { pauseRecordOf } from "../framework-json.js";
import { DUPLICATE_KEY, hasCode, idOf } from "../keys.js";
import { nextSequence } from "../sequence.js";

/**
 * The pauses of `MongoPausedExecutionRepository` (#267 S35): one document per pause, `_id` its
 * tenant and pause id, unique per step key of a tree (agbossjs/agboss#663: a step key names no tree)
 * by an index. The record as the framework made it is JSON text; what changes after — `status`,
 * `isSent`, the closing (resolution, its time, the answer) — are fields of their own, laid over the
 * record when read. A transition of a pending pause is one update whose filter is `status:
 * "pending"`, so of two instances exactly one changes it, and the record is never out of step with
 * its status.
 */
export interface PauseDocument {
  _id: string;
  tenantId: string;
  pauseId: string;
  rootExecutionId: string;
  stepKey: string;
  seq: number;
  status: PauseStatus;
  isSent: boolean;
  resolvedAt: Date | null;
  /** The record as created, JSON text. */
  record: string;
  /** How it closed — `{ status, resolution, resolvedAt, answer? }` —, JSON text; `null` while pending. */
  closing: string | null;
}

/** How a pending pause closes: its new status, how and when, and the answer when it has one. */
export interface PauseClosing {
  readonly status: PauseStatus;
  readonly resolution: PauseResolution;
  readonly at: Date;
  readonly answer?: PauseAnswer;
}

const Stored = z.object({
  status: z.enum(PauseStatus),
  isSent: z.boolean(),
  record: z.string(),
  closing: z.string().nullable(),
});

const ClosingFields = z.record(z.string(), z.unknown());

/** The record a document keeps: the created record, its closing over it, its status and sending. */
export function pauseOfDocument(found: unknown): PauseRecord {
  const stored = Stored.parse(found);
  const closing = stored.closing === null ? {} : ClosingFields.parse(JSON.parse(stored.closing));
  const created = ClosingFields.parse(JSON.parse(stored.record));
  return pauseRecordOf({ ...created, ...closing, status: stored.status, isSent: stored.isSent });
}

export const pauseIdOf = (tenantId: string, pauseId: string): string => idOf(tenantId, pauseId);

/** The pause of the step in its tenant's tree when one exists, else `pause` saved — one upsert, then a read. */
export async function findOrCreatePause(db: Db, pause: PauseRecord): Promise<PauseRecord> {
  const pauses = db.collection<PauseDocument>(Collections.Pauses);
  const step = {
    tenantId: pause.tenantId,
    rootExecutionId: pause.rootExecutionId,
    stepKey: pause.stepKey,
  };
  const document: PauseDocument = {
    _id: pauseIdOf(pause.tenantId, pause.pauseId),
    ...step,
    pauseId: pause.pauseId,
    seq: await nextSequence(db, Collections.Pauses),
    status: pause.status,
    isSent: pause.isSent,
    resolvedAt: null,
    record: JSON.stringify(pause),
    closing: null,
  };
  try {
    await pauses.updateOne(step, { $setOnInsert: document }, { upsert: true });
  } catch (error) {
    // another instance made the step's pause at the same time: it is the one read below
    if (!hasCode(error, DUPLICATE_KEY)) throw error;
  }
  return pauseOfDocument(await pauses.findOne(step));
}

/** The pending pause closed; the record as stored now, `undefined` when it was not pending. */
export async function closePause(
  pauses: Collection<PauseDocument>,
  tenantId: string,
  pauseId: string,
  closing: PauseClosing,
): Promise<PauseRecord | undefined> {
  const fields = {
    status: closing.status,
    resolution: closing.resolution,
    resolvedAt: closing.at.toISOString(),
    ...(closing.answer === undefined ? {} : { answer: closing.answer }),
  };
  const closed = await pauses.findOneAndUpdate(
    { _id: pauseIdOf(tenantId, pauseId), status: PauseStatus.Pending },
    { $set: { status: closing.status, resolvedAt: closing.at, closing: JSON.stringify(fields) } },
    { returnDocument: "after" },
  );
  return closed === null ? undefined : pauseOfDocument(closed);
}
