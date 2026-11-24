import { OutboundCallStatus, type OutboundCallRecord } from "@agboss/core";
import { effectKeyIdentityOf, type EffectKey } from "@agboss/core/stores";
import type { Filter, UpdateFilter } from "mongodb";
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
  /**
   * When the ended call may be removed (#1317: `now + ttl` of its end, a date), `null` while pending
   * and for `Ttl.Forever`: what `deleteExpired` and its index read.
   */
  expiresAt: Date | null;
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
  // agbossjs/agboss#658: on the store's time; none on a document written before
  attemptStartedAt: text.optional(),
  firstAttemptStartedAt: text.optional(),
});

const CallDocument = z.object({ record: z.unknown() });

/** The record a document keeps. */
export const callRecordOf = (found: unknown): OutboundCallRecord =>
  StoredCall.parse(CallDocument.parse(found).record);

/** The `_id` of `key`'s intent. */
export const callIdOf = (key: EffectKey): string => idOf(effectKeyIdentityOf(key));

/** The record's fields that a move leaves out: its last ending (`result`, `failure`, `endedAt`). */
export const ENDING_FIELDS = ["record.result", "record.failure", "record.endedAt"] as const;

/** The state the document must still be in: its status and attempt owner, its attempt when given. */
export interface AsRead {
  readonly status: OutboundCallStatus;
  readonly attempt?: number;
  readonly attemptOwner: string;
}

/** The change of a compare-and-set: the record's new fields, and its new end. */
export interface Change {
  readonly fields: Partial<OutboundCallRecord>;
  readonly expiresAt?: Date | null;
}

/** A change as of the store's time the fence decided by. */
export type ChangeAt = (now: Date) => Change;

/**
 * The compare-and-set of `key`'s document: the filter — the status, attempt owner and, when given,
 * attempt the caller read — and the update that writes `change` under the key's lease and token (the
 * record's own fields, the fields it is found by, `expiresAt`; a move leaves out the last ending).
 */
export function moveOf(
  key: EffectKey,
  from: AsRead,
  change: Change,
): {
  readonly filter: Filter<OutboundCallDocument>;
  readonly update: UpdateFilter<OutboundCallDocument>;
} {
  const fields = { ...change.fields, token: key.token, leaseExecutionId: key.leaseExecutionId };
  const set = Object.fromEntries(
    Object.entries(fields).map(([field, value]) => [`record.${field}`, value]),
  );
  const unset = ENDING_FIELDS.filter((field) => !(field in set));
  return {
    filter: {
      _id: callIdOf(key),
      status: from.status,
      attemptOwner: from.attemptOwner,
      ...(from.attempt === undefined ? {} : { attempt: from.attempt }),
    },
    update: {
      $set: {
        ...set,
        status: fields.status ?? from.status,
        ...(fields.attempt === undefined ? {} : { attempt: fields.attempt }),
        ...(fields.attemptOwner === undefined ? {} : { attemptOwner: fields.attemptOwner }),
        expiresAt: change.expiresAt ?? null,
      },
      ...(unset.length === 0
        ? {}
        : {
            // Stryker disable next-line StringLiteral: equivalent, the server ignores the value of a field of $unset
            $unset: Object.fromEntries(unset.map((field) => [field, ""])),
          }),
    },
  };
}
