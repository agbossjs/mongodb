import { MongoClient } from "mongodb";
import { REPLICA_SET_URL } from "./server.js";

/**
 * The change-stream cursors the servers hold for a database (agbossjs/agboss#1088), read from
 * `$currentOp` with `idleCursors` on every member of the replica set: a cursor between two
 * `getMore`s is an `idleCursor`, one inside an awaiting `getMore` is a running `getmore`. Both carry
 * the cursor and the command that opened it.
 */
interface CursorEntry {
  readonly ns?: string;
  readonly cursor?: {
    readonly cursorId?: { toString(): string };
    readonly originatingCommand?: { readonly pipeline?: readonly Record<string, unknown>[] };
  };
}

/** The ids of the database's change-stream cursors on the members, as `member/cursorId`. */
export async function changeStreamCursors(database: string): Promise<string[]> {
  const seed = new MongoClient(REPLICA_SET_URL);
  try {
    const hello = await seed.db("admin").command({ hello: 1 });
    const found: string[] = [];
    for (const member of hello.hosts as string[]) {
      const direct = new MongoClient(`mongodb://${member}/?directConnection=true`);
      try {
        const entries = await direct
          .db("admin")
          .aggregate<CursorEntry>([{ $currentOp: { allUsers: true, idleCursors: true } }])
          .toArray();
        for (const entry of entries) {
          const pipeline = entry.cursor?.originatingCommand?.pipeline;
          if (!String(entry.ns).startsWith(`${database}.`)) continue;
          if (!pipeline?.some((stage) => "$changeStream" in stage)) continue;
          found.push(`${member}/${String(entry.cursor?.cursorId)}`);
        }
      } finally {
        await direct.close();
      }
    }
    return found.sort();
  } finally {
    await seed.close();
  }
}
