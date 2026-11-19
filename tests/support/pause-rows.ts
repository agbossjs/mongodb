import { PauseStatus, type PauseRecord } from "@agboss/core";
import type { Db } from "mongodb";
import { Collections } from "../../src/index.js";
import {
  fieldsOf,
  pauseIdOf,
  type PauseDocument,
} from "../../src/stores/paused/pause-documents.js";
import {
  mailboxIdOf,
  mailboxesOf,
  type MailboxDocument,
} from "../../src/stores/paused/pause-mailboxes.js";
import { pauseOf } from "./pauses.js";

/**
 * Rows no store write makes, in the order a test chooses: a pause whose `seq` is not its insertion
 * order, a mailbox as a database would hold it — so that an order a scan must give is the scan's,
 * never the order the rows happen to lie in.
 */

/** Inserts the pause `id` of the default tenant with sequence `seq`, as `fields` make its record. */
export async function insertPauseRow(
  db: Db,
  id: string,
  seq: number,
  fields: Partial<PauseRecord> = {},
  extra: Partial<PauseDocument> = {},
): Promise<void> {
  const record: PauseRecord = { ...pauseOf(id), ...fields };
  const document: PauseDocument = {
    _id: pauseIdOf(record.tenantId, id),
    tenantId: record.tenantId,
    pauseId: id,
    rootExecutionId: record.rootExecutionId,
    stepKey: record.stepKey,
    seq,
    channel: record.channel,
    record: JSON.stringify(record),
    ...fieldsOf(record),
    ...extra,
  };
  await db.collection<PauseDocument>(Collections.Pauses).insertOne(document);
}

/** A closed (taken) pause resolved at `resolvedAt`. */
export const insertTakenRow = (
  db: Db,
  id: string,
  seq: number,
  resolvedAt: string,
): Promise<void> => insertPauseRow(db, id, seq, { status: PauseStatus.Taken, resolvedAt });

/** Inserts a mailbox of the pause `id` for `recipient`, one notice written at `headWrittenAt`, due at `nextAttemptAt`. */
export async function insertMailboxRow(
  db: Db,
  id: string,
  fields: Partial<MailboxDocument> & {
    readonly headWrittenAt: Date | null;
    readonly nextAttemptAt: Date;
  },
  recipient = "listener:audit",
): Promise<void> {
  await mailboxesOf(db).insertOne({
    _id: mailboxIdOf("default", id, recipient),
    tenantId: "default",
    pauseId: id,
    recipient,
    notices: [{ seq: 1, kind: "opened", writtenAt: fields.headWrittenAt ?? new Date(0) }],
    delivered: 0,
    attempts: 0,
    isDead: false,
    claimToken: null,
    claimedUntil: null,
    ...fields,
  });
}

/** `count` taken pauses `t0`, `t1`, … resolved at `resolvedAt`, in one write. */
export async function insertTakenRows(db: Db, count: number, resolvedAt: string): Promise<void> {
  const documents = Array.from({ length: count }, (_, seq): PauseDocument => {
    const record: PauseRecord = {
      ...pauseOf(`t${String(seq)}`),
      status: PauseStatus.Taken,
      resolvedAt,
    };
    return {
      _id: pauseIdOf(record.tenantId, record.pauseId),
      tenantId: record.tenantId,
      pauseId: record.pauseId,
      rootExecutionId: record.rootExecutionId,
      stepKey: record.stepKey,
      seq: seq + 1,
      channel: record.channel,
      record: JSON.stringify(record),
      ...fieldsOf(record),
    };
  });
  await db.collection<PauseDocument>(Collections.Pauses).insertMany(documents);
}
