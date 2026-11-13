import type { Document, MongoClient } from "mongodb";
import { z } from "zod";

/**
 * agbossjs/agboss#985 — the transactions a killed or frozen pod leaves open. The server keeps one
 * until its lifetime limit (`transactionLifetimeLimitSeconds`, 60 s) and a sweep ends it, and
 * holds the database's lock meanwhile: a `dropDatabase` waits for it. A pod names its client by the
 * database it works on (`appName`), so the teardown ends the open transactions of its own
 * databases' pods, no other client's.
 */

/** A session id as the server names it (an object: its `id` a UUID, its `uid` a digest). */
const SessionId = z.custom<Document>((value) => typeof value === "object" && value !== null);

/** The `appName` of the pods of a fault scenario's `database`. */
export const podAppName = (database: string): string => `agboss-fault-${database}`;

/**
 * Ends the sessions of the pods of `databases` that hold an open transaction; how many. The pods
 * are dead or finished by then: nothing live is cut.
 */
export async function endAbandonedTransactions(
  client: MongoClient,
  databases: readonly string[],
): Promise<number> {
  const open = await client
    .db("admin")
    .aggregate([
      { $currentOp: { allUsers: true, idleSessions: true } },
      {
        $match: {
          appName: { $in: databases.map(podAppName) },
          transaction: { $exists: true },
        },
      },
      { $project: { lsid: 1 } },
    ])
    .toArray();
  if (open.length === 0) return 0;
  const lsids = open.map((op) => SessionId.parse(op.lsid));
  await client.db("admin").command({ killSessions: lsids });
  return open.length;
}
