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

/** The cluster time a command's reply carries, when it does. */
export const clusterTimeOf = (reply: Document): Timestamp | undefined => {
  const time: unknown = reply.operationTime;
  return time instanceof Timestamp ? time : undefined;
};
