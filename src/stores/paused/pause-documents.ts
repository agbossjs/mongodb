import { PauseStatus, type PauseRecord } from "@agboss/core";
import { assertPauseInstants, StoreError } from "@agboss/core/stores";
import type { ClientSession, Db, UpdateFilter } from "mongodb";
import { z } from "zod";
import { Collections } from "../../connection/collections.js";
import { pauseRecordOf } from "../framework-json.js";
import { parsedOrUnreadable } from "../unreadable.js";
import { DUPLICATE_KEY, hasCode, idOf } from "../keys.js";
import { nextSequence } from "../sequence.js";

/**
 * The pauses of `MongoPausedExecutionRepository` (#267 S35, #938): one document per pause, `_id`
 * its tenant and pause id, unique per step key of a tree (agbossjs/agboss#663) by an index. The
 * record as the framework made it is JSON text; what changes after — `status`, `isSent`, the
 * closing (resolution, its time, the answer) and the deadline fields — are fields of their own,
 * laid over the record when read: `expiresAt`, `remindAt` and `resolvedAt` are BSON Dates (the
 * indexes' and the scans' keys), `target` is copied out for the tenant's pages. A document of
 * schema version 1 has no deadline fields: its record's are read (it has none). The fields a
 * listing filters by (`assignees`, `externalRef`, `channel`, #1307e) are copied out beside the record
 * — absent when the pause has none, never `null` — and kept as the record has them; the record
 * (`firstAskedAt`, `maxExpiresAt`, `escalationLimits`, the trail) is the one source of what is read back.
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
  target: string;
  expiresAt: Date | null;
  remindAt: Date | null;
  expiryBound: string | null;
  /** Who the pause is for (a pool: any member matches a listing's `assignee`): a multikey index; absent when nobody in particular. */
  assignees?: string[];
  /** The reference the channel's system gave it (`by_external_ref`); absent until it has one. */
  externalRef?: string;
  /** The name of the channel that asks it (a listing's `channel`); absent when it has none. */
  channel?: string;
  /** The record as created, JSON text. */
  record: string;
  /** How it closed — `{ status, resolution, resolvedAt, answer?, expiryProblem? }` —, JSON text; `null` while pending. */
  closing: string | null;
  /** The id of the pause that replaced this one (#946): kept while its replacement is stored. */
  reassignedTo?: string | null;
  /** A replacement's (#946): the id of the pause it replaced, and when it was asked — the re-send scan's index. */
  reassignedFrom?: string;
  askedAt?: Date;
  /** How many times `noticeOnce…` wrote: a write to the pause that locks it against the retention's delete. */
  noticeWrites?: number;
}

/** What a pause's listing fields are as a new document holds them: only those it has. */
export const listingFieldsOf = (
  pause: PauseRecord,
): Pick<PauseDocument, "assignees" | "externalRef" | "channel"> => ({
  ...(pause.assignees === undefined ? {} : { assignees: [...pause.assignees] }),
  ...(pause.externalRef === undefined ? {} : { externalRef: pause.externalRef }),
  ...(pause.channel === undefined ? {} : { channel: pause.channel }),
});

/** The fields of a document a change of its pause sets. */
export type PauseFields = Pick<
  PauseDocument,
  "status" | "isSent" | "resolvedAt" | "expiresAt" | "remindAt" | "expiryBound" | "closing"
> & { reassignedTo: string | null };

const Stored = z.object({
  status: z.enum(PauseStatus),
  isSent: z.boolean(),
  record: z.string(),
  closing: z.string().nullable(),
  expiresAt: z.date().nullable().optional(),
  remindAt: z.date().nullable().optional(),
  // never read back as such, but a query's key: a text here would sort apart (retention, the re-send scan)
  resolvedAt: z.date().nullable().optional(),
  askedAt: z.date().optional(),
  expiryBound: z.string().nullable().optional(),
});
const Ids = z.object({ pauseId: z.string().optional(), rootExecutionId: z.string().optional() });

const Fields = z.record(z.string(), z.unknown());

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
  // a text where a BSON Date belongs (a hand-written migration's) is refused, naming the field, never the value
  const parsed = Stored.safeParse(found);
  // a text that is not JSON names the pause by its ids, never by the text or a tenant (#906 D4)
  const ids = Ids.parse(found);
  if (!parsed.success)
    throw new StoreError.UnreadableRecord({
      record: "pause",
      ids: Object.entries(ids)
        .flatMap(([key, value]) => (typeof value === "string" ? [`${key} ${value}`] : []))
        .join(", "),
      fields: parsed.error.issues.map((issue) => issue.path.join(".")).join(", "),
    });
  const stored = parsed.data;
  const closing =
    stored.closing === null ? {} : Fields.parse(parsedOrUnreadable("pause", stored.closing, ids));
  const created = Fields.parse(parsedOrUnreadable("pause", stored.record, ids));
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
  const { status, resolution, resolvedAt, answer, expiryProblem, closedFirst, reassignedTo } =
    pause;
  const fields = {
    ...{ status, resolution, resolvedAt, answer, expiryProblem, closedFirst },
    reassignedTo,
  };
  return JSON.stringify(fields);
}

/** The fields a change of a pause sets: status, sending, closing and deadlines, as the record has them now. */
export function fieldsOf(pause: PauseRecord): PauseFields {
  // an Invalid Date is no BSON Date and no JSON time: refused before anything is written
  assertPauseInstants(pause);
  return {
    status: pause.status,
    isSent: pause.isSent,
    resolvedAt: pause.resolvedAt ?? null,
    expiresAt: pause.expiresAt ?? null,
    remindAt: pause.remindAt ?? null,
    expiryBound: pause.expiryBound ?? null,
    closing: closingOf(pause),
    reassignedTo: pause.reassignedTo ?? null,
  };
}

/**
 * What a change of `before` into `after` writes: the fields of its status, closing and deadlines,
 * and — when its chain of custody or its pool of assignees changed (a deadline moved, a reassignment,
 * the channel's reference), which the created record holds — the record itself, whole, with the
 * listing fields that follow it: `assignees` and `externalRef` set, or unset when the record has
 * none (never `null`). The channel of a pause never changes.
 */
export function writtenFieldsOf(
  before: PauseRecord,
  after: PauseRecord,
): UpdateFilter<PauseDocument> {
  const isRecordChanged =
    after.trail !== before.trail ||
    after.assignees !== before.assignees ||
    after.externalRef !== before.externalRef;
  if (!isRecordChanged) return { $set: fieldsOf(after) };
  const { assignees, externalRef } = listingFieldsOf(after);
  // an empty `$unset` is an error before MongoDB 5.0: named only when there is a field to remove
  const unset = {
    ...(assignees === undefined ? { assignees: "" as const } : {}),
    ...(externalRef === undefined ? { externalRef: "" as const } : {}),
  };
  return {
    $set: {
      ...fieldsOf(after),
      record: JSON.stringify(after),
      ...(assignees === undefined ? {} : { assignees }),
      ...(externalRef === undefined ? {} : { externalRef }),
    },
    ...(Object.keys(unset).length === 0 ? {} : { $unset: unset }),
  };
}

/** `pause` inserted as a new document of the pauses (#946: a reassignment's replacement), in `session`. */
export async function insertPause(
  db: Db,
  session: ClientSession,
  pause: PauseRecord,
): Promise<void> {
  // before the sequence is drawn: a refused pause leaves no trace, not even a gap in the numbers
  assertPauseInstants(pause);
  const document: PauseDocument = {
    _id: pauseIdOf(pause.tenantId, pause.pauseId),
    tenantId: pause.tenantId,
    rootExecutionId: pause.rootExecutionId,
    stepKey: pause.stepKey,
    pauseId: pause.pauseId,
    seq: await nextSequence(db, Collections.Pauses),
    target: pause.target,
    record: JSON.stringify(pause),
    ...fieldsOf(pause),
    ...listingFieldsOf(pause),
    ...(pause.reassignedFrom === undefined
      ? {}
      : { reassignedFrom: pause.reassignedFrom, askedAt: pause.askedAt }),
  };
  await db.collection<PauseDocument>(Collections.Pauses).insertOne(document, { session });
}

/** The pause of the step in its tenant's tree when one exists, else `pause` saved — one upsert, then a read. */
export async function findOrCreatePause(db: Db, pause: PauseRecord): Promise<PauseRecord> {
  assertPauseInstants(pause);
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
    target: pause.target,
    record: JSON.stringify(pause),
    ...fieldsOf(pause),
    ...listingFieldsOf(pause),
  };
  try {
    await pauses.updateOne(step, { $setOnInsert: document }, { upsert: true });
  } catch (error) {
    // another instance made the step's pause at the same time: it is the one read below
    if (!hasCode(error, DUPLICATE_KEY)) throw error;
  }
  return pauseOfDocument(await pauses.findOne(step));
}
