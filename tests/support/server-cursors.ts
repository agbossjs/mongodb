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

/** One client per member, kept for the whole file: a poll of every 250 ms must not open a connection each time. */
const probes = new Map<string, MongoClient>();

const probeOf = (member: string): MongoClient => {
  let probe = probes.get(member);
  if (probe === undefined) {
    probe = new MongoClient(`mongodb://${member}/?directConnection=true`, { maxPoolSize: 1 });
    probes.set(member, probe);
  }
  return probe;
};

/** Closes the probes (after the file's tests). */
export async function closeCursorProbes(): Promise<void> {
  await Promise.all([...probes.values()].map((probe) => probe.close()));
  probes.clear();
}

/** The ids of the database's change-stream cursors on the members, as `member/cursorId`. */
export async function changeStreamCursors(database: string): Promise<string[]> {
  const found: string[] = [];
  for (const member of await members()) {
    const entries = await probeOf(member)
      .db("admin")
      .aggregate<CursorEntry>([{ $currentOp: { allUsers: true, idleCursors: true } }])
      .toArray();
    for (const entry of entries) {
      const pipeline = entry.cursor?.originatingCommand?.pipeline;
      if (!String(entry.ns).startsWith(`${database}.`)) continue;
      if (!pipeline?.some((stage) => "$changeStream" in stage)) continue;
      found.push(`${member}/${String(entry.cursor?.cursorId)}`);
    }
  }
  return found.sort();
}

let hosts: string[] | undefined;

/** The replica set's members (they do not change during a test file). */
async function members(): Promise<string[]> {
  if (hosts === undefined) {
    const seed = new MongoClient(REPLICA_SET_URL);
    try {
      const hello = await seed.db("admin").command({ hello: 1 });
      hosts = hello.hosts as string[];
    } finally {
      await seed.close();
    }
  }
  return hosts;
}
