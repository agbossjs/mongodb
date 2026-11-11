import type { Turn } from "@agboss/core";
import type { Db } from "mongodb";
import { z } from "zod";
import { Collections } from "../../connection/collections.js";

/**
 * The documents of `agboss_execution_records`, validated on the way out, as the core's own record
 * types (`Turn`, `Summary`, …: exported with its contract, agbossjs/agboss#511, #890) — never local
 * aliases. A record's
 * place is its `seq`, the next number of the records' sequence when it was appended.
 */

/** One record: the core's fields (`createdAt` a date), `_id` its id, `seq` its place. */
export interface RecordDocument extends Omit<Turn, "id" | "createdAt"> {
  _id: string;
  seq: number;
  createdAt: Date;
}

/** The statuses a record has (`ExecutionRecordStatus`'s values). */
const STATUSES = [
  "running",
  "answered",
  "guarded",
  "failed",
  "paused",
  "queued",
  "written",
] as const satisfies readonly Turn["status"][];

const text = z.string();

const Stored = z.object({
  _id: text,
  runId: text.nullable(),
  tenantId: text,
  threadId: text,
  bundle: text,
  createdAt: z.date(),
  task: text,
  replyWith: text,
  status: z.enum(STATUSES),
  stopReason: text,
  route: z.array(text),
  steps: z.array(z.object({ agent: text, content: text })),
  costUsd: z.number(),
  promptVersion: text,
  modelVersion: text,
  replayOf: text.nullable(),
  configVersion: text.nullable(),
  configHash: text.nullable(),
});

/** A document of `agboss_execution_records` as the record it keeps. */
export function recordOf(found: unknown): Turn {
  const { _id, createdAt, ...record } = Stored.parse(found);
  return { ...record, id: _id, createdAt: createdAt.toISOString() };
}

/** The records of documents, in their order. */
export const recordsOf = (found: readonly unknown[]): Turn[] => found.map(recordOf);

const Seq = z.object({ seq: z.number().int() });

/** The `seq` of record `id`; `undefined` for an unknown id. */
export async function seqOf(db: Db, id: string): Promise<number | undefined> {
  const found = await db
    .collection<{ _id: string; seq: number }>(Collections.ExecutionRecords)
    .findOne({ _id: id }, { projection: { seq: 1 } });
  return found === null ? undefined : Seq.parse(found).seq;
}

/** The newest `limit` documents a cursor sorted newest first gave, oldest first. */
export const oldestFirst = <TValue>(newest: readonly TValue[]): TValue[] => [...newest].reverse();
