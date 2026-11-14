import type { ExecutionHistoryRecord } from "@agboss/core";
import { executionHistoryRecordOfJson } from "@agboss/core/stores";
import { z } from "zod";
import { parsedOrUnreadable } from "../unreadable.js";

/**
 * A document of `agboss_execution_history` read back: its `record` is the JSON `save` wrote, or
 * 0.1.0's. The core reads it (#934): the fields the history is found and exported by are checked, and
 * so is every pause of the record and of its children, at any depth. A document that is not one fails
 * with `StoredNamesUnreadableError`, naming the ids and the field, never half-read.
 */
const HistoryDocument = z.object({ record: z.string(), executionId: z.string().optional() });

/** The record of a document. */
export const historyRecordOf = (row: unknown): ExecutionHistoryRecord => {
  const { record, executionId } = HistoryDocument.parse(row);
  return executionHistoryRecordOfJson(
    parsedOrUnreadable("execution history record", record, { executionId }),
  );
};
