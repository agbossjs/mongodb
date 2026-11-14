import { PauseStatus, type PauseRecord } from "@agboss/core";
import type { Db } from "mongodb";
import { z } from "zod";
import { Collections } from "../../connection/collections.js";
import { pauseRecordOf } from "../framework-json.js";
import { parsedOrUnreadable } from "../unreadable.js";
import { pauseFieldsOfVersion } from "./pause-kind.js";
import { DUPLICATE_KEY, hasCode, idOf } from "../keys.js";
import { nextSequence } from "../sequence.js";

/**
 * The pauses of `MongoPausedExecutionRepository` (#267 S35, #938): one document per pause, `_id`
 * its tenant and pause id, unique per step key of a tree (agbossjs/agboss#663) by an index. The
 * record as the framework made it is JSON text; what changes after — `status`, `isSent`, the
 * closing (resolution, its time, the answer) and the deadline fields — are fields of their own,
 * laid over the record when read: `expiresAt`, `remindAt` and `resolvedAt` are BSON Dates (the
 * indexes' and the scans' keys), `channel` is copied out for the tenant's pages. A document of
 * schema version 1 has no deadline fields: its record's are read (it has none).
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
  channel: string;
  expiresAt: Date | null;
  remindAt: Date | null;
  expiryBound: string | null;
  /** The record as created, JSON text. */
  record: string;
  /** How it closed — `{ status, resolution, resolvedAt, answer?, expiryProblem? }` —, JSON text; `null` while pending. */
  closing: string | null;
  /** How many times `noticeOnce…` wrote: a write to the pause that locks it against the retention's delete. */
  noticeWrites?: number;
}

/** The fields of a document a change of its pause sets. */
export type PauseFields = Pick<
  PauseDocument,
  "status" | "isSent" | "resolvedAt" | "expiresAt" | "remindAt" | "expiryBound" | "closing"
>;

const Stored = z.object({
  status: z.enum(PauseStatus),
  isSent: z.boolean(),
  record: z.string(),
  closing: z.string().nullable(),
  expiresAt: z.date().nullable().optional(),
  remindAt: z.date().nullable().optional(),
  expiryBound: z.string().nullable().optional(),
});
const Ids = z.object({ pauseId: z.string().optional(), rootExecutionId: z.string().optional() });

const Fields = z.record(z.string(), z.unknown());

/** The instant of an ISO 8601 text a record holds; a text that is none is a `TypeError`. */
export function dateOf(text: string, field: string): Date {
  const instant = new Date(text);
  if (Number.isNaN(instant.getTime()))
    throw new TypeError(`a pause's ${field} is an ISO 8601 time, not ${JSON.stringify(text)}`);
  return instant;
}

/** `text` as a BSON Date, `null` when absent. */
export const dateOrNull = (text: string | undefined, field: string): Date | null =>
  text === undefined ? null : dateOf(text, field);

/** The deadline fields a document keeps over its record's: `undefined` for a document without them. */
function deadlinesOf(stored: z.infer<typeof Stored>): readonly (readonly [string, unknown])[] {
  const iso = (date: Date | null | undefined): Date | string | null | undefined =>
    date instanceof Date ? date.toISOString() : date;
  return [
    ["expiresAt", iso(stored.expiresAt)],
    ["remindAt", iso(stored.remindAt)],
    ["expiryBound", stored.expiryBound],
  ];
}

/** The record a document keeps: the created record, its closing over it, its status, sending and deadlines. */
export function pauseOfDocument(found: unknown): PauseRecord {
  const stored = Stored.parse(found);
  // a text that is not JSON names the pause by its ids, never by the text or a tenant (#906 D4)
  const ids = Ids.parse(found);
  const closing =
    stored.closing === null ? {} : Fields.parse(parsedOrUnreadable("pause", stored.closing, ids));
  const created = pauseFieldsOfVersion(
    Fields.parse(parsedOrUnreadable("pause", stored.record, ids)),
  );
  const record: Record<string, unknown> = {
    ...created,
    ...closing,
    status: stored.status,
    isSent: stored.isSent,
  };
  for (const [key, value] of deadlinesOf(stored)) {
    if (value === null) Reflect.deleteProperty(record, key);
    else if (value !== undefined) record[key] = value;
  }
  return pauseRecordOf(record);
}

export const pauseIdOf = (tenantId: string, pauseId: string): string => idOf(tenantId, pauseId);

/** How a closed record closed, as the JSON `closing` keeps it; `null` while it is pending. */
export function closingOf(pause: PauseRecord): string | null {
  if (pause.status === PauseStatus.Pending) return null;
  const { status, resolution, resolvedAt, answer, expiryProblem, closedFirst } = pause;
  const fields = { status, resolution, resolvedAt, answer, expiryProblem, closedFirst };
  return JSON.stringify(fields);
}

/** The fields a change of a pause sets: status, sending, closing and deadlines, as the record has them now. */
export function fieldsOf(pause: PauseRecord): PauseFields {
  return {
    status: pause.status,
    isSent: pause.isSent,
    resolvedAt: dateOrNull(pause.resolvedAt, "resolvedAt"),
    expiresAt: dateOrNull(pause.expiresAt, "expiresAt"),
    remindAt: dateOrNull(pause.remindAt, "remindAt"),
    expiryBound: pause.expiryBound ?? null,
    closing: closingOf(pause),
  };
}

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
    channel: pause.channel,
    record: JSON.stringify(pause),
    ...fieldsOf(pause),
  };
  try {
    await pauses.updateOne(step, { $setOnInsert: document }, { upsert: true });
  } catch (error) {
    // another instance made the step's pause at the same time: it is the one read below
    if (!hasCode(error, DUPLICATE_KEY)) throw error;
  }
  return pauseOfDocument(await pauses.findOne(step));
}
