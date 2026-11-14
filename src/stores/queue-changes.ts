import { ExecutionRecordStatus } from "@agboss/core";
import { seconds, type Milliseconds } from "@agboss/core/units";
import { Timestamp, type Document } from "mongodb";

/**
 * How long the server holds an idle `getMore` of the stream: a quarter of the liveness bound, so a
 * ping queued behind it is answered well inside the half of the bound it is given.
 */
export const awaitFor = (livenessSeconds: number): Milliseconds => seconds(livenessSeconds / 4);

/** The pauses before each attempt to open the stream again; the last one repeats. */
export const PAUSES = [1, 2, 4, 8, 16, 30].map((pause) => seconds(pause));

/** The changes that queue a child: only their ids leave the server. */
export const QUEUED_CHANGES: Document[] = [
  {
    $match: {
      $or: [
        {
          operationType: { $in: ["insert", "replace"] },
          "fullDocument.status": ExecutionRecordStatus.Queued,
        },
        {
          operationType: "update",
          "updateDescription.updatedFields.status": ExecutionRecordStatus.Queued,
        },
      ],
    },
  },
  { $project: { _id: 1 } },
];

/**
 * The first cluster time after the one a command's reply carries (`ping`'s `operationTime`: the
 * last write the server had applied), or undefined when the reply has none. A stream's
 * `startAtOperationTime` is inclusive, so it starts here, not at the ping's own time:
 * that write — a child already queued, or a `drop` that invalidated the last stream — is not
 * replayed (agbossjs/agboss#1028). Cluster times are unique, so a write made after the ping is
 * never before this one.
 */
export const startAfter = (reply: Document): Timestamp | undefined => {
  const time: unknown = reply.operationTime;
  if (!(time instanceof Timestamp)) return undefined;
  const wraps = time.i === 0xffffffff;
  return new Timestamp({ t: wraps ? time.t + 1 : time.t, i: wraps ? 0 : time.i + 1 });
};
