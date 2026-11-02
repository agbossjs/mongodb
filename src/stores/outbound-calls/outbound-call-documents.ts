import {
  fencedKeyIdentityOf,
  OutboundCallStatus,
  type FencedEffectKey,
  type OutboundCallRecord,
} from "@agboss/core";
import { z } from "zod";
import { idOf } from "../keys.js";

/**
 * The documents of `agboss_outbound_calls` (agbossjs/agboss#505, #508): one per intent, `_id` its
 * key's identity (by its step, or by its tenant, name and business key), the record's own fields
 * beside the ones it is found and compared by — `seq` (the order recorded), `endedAt` as a date for
 * the sweep. BSON keeps every text as it was given, a NUL character included, so nothing is escaped.
 * A document read back is checked field by field: documents are never trusted.
 */
export interface OutboundCallDocument {
  _id: string;
  seq: number;
  record: OutboundCallRecord;
  tenantId: string;
  rootExecutionId: string;
  status: OutboundCallStatus;
  attempt: number;
  attemptOwner: string;
  /** When it last ended, a date (the record keeps it as ISO text); `null` while pending. */
  endedAt: Date | null;
}

const text = z.string();
const Failure = z.strictObject({ name: text, code: text, message: text });

const StoredCall = z.strictObject({
  rootExecutionId: text,
  executionId: text,
  workflow: text,
  target: text,
  operation: text,
  idempotencyKey: text,
  request: text,
  attempt: z.number().int(),
  attemptOwner: text,
  step: z.strictObject({ nodeId: text, visitNumber: z.number().int() }),
  tenantId: text,
  name: text,
  status: z.enum(OutboundCallStatus),
  result: text.optional(),
  failure: Failure.optional(),
  token: z.number().int(),
  leaseExecutionId: text,
  businessKey: text.optional(),
  fingerprint: text.optional(),
  businessKeyHash: text.optional(),
  recordedAt: text,
  endedAt: text.optional(),
});

const CallDocument = z.object({ record: z.unknown() });

/** The record a document keeps. */
export const callRecordOf = (found: unknown): OutboundCallRecord =>
  StoredCall.parse(CallDocument.parse(found).record);

/** The `_id` of `key`'s intent. */
export const callIdOf = (key: FencedEffectKey): string => idOf(fencedKeyIdentityOf(key));

/** The record's fields that a move leaves out: its last ending (`result`, `failure`, `endedAt`). */
export const ENDING_FIELDS = ["record.result", "record.failure", "record.endedAt"] as const;
