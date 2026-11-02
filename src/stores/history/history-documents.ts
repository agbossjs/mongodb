import { ExecutionHistoryStatus, type ExecutionHistoryRecord } from "@agboss/core";
import { z } from "zod";

/**
 * A document of `agboss_execution_history` read back: its `record` is the JSON `save` wrote,
 * checked for the fields the history is found and exported by — the rest passed through as written
 * (the framework wrote it). A document that is not one fails loudly, never half-read.
 */

const text = z.string();

const StoredHistoryRecord = z.looseObject({
  executionId: text,
  rootExecutionId: text,
  threadId: text,
  tenantId: text,
  application: z.looseObject({ name: text, version: text, instanceId: text }),
  workflow: z.looseObject({ name: text, version: text }),
  status: z.enum(ExecutionHistoryStatus),
  startedAt: text,
  endedAt: text.optional(),
  start: z.looseObject({ name: text, kind: text }),
  contexts: z.looseObject({
    tenant: z.record(text, z.unknown()),
    execution: z.record(text, z.unknown()),
  }),
});

const HistoryDocument = z.object({ record: z.string() });

const isHistoryRecord = (value: unknown): value is ExecutionHistoryRecord =>
  StoredHistoryRecord.safeParse(value).success;

/** The record of a document. */
export function historyRecordOf(row: unknown): ExecutionHistoryRecord {
  const record = JSON.parse(HistoryDocument.parse(row).record) as unknown;
  if (!isHistoryRecord(record))
    throw new Error(`a stored execution history record is not readable: ${JSON.stringify(record)}`);
  return record;
}
