import type { MongoClient } from "mongodb";

/**
 * agbossjs/agboss#985 — a test file's teardown: every database it made dropped in bounded parallel,
 * each drop with a bound of its own. A drop waits for the database's lock, and a pod killed (or
 * frozen) inside a transaction leaves that transaction open on the server until its lifetime limit
 * (60 s) and the sweep that ends it: dropped one after another, three such databases outlast any
 * hook. A drop that does not finish is reported by name, never thrown (a suite whose tests passed
 * does not fail on its cleanup), and never silent: the leaked databases are counted.
 */

/** One drop's bound, ms: the server's `maxTimeMS` and `wtimeout`; the client gives up a little later. */
export const DROP_BOUND_MS = 20_000;

/** How many drops run at once. */
export const DROP_CONCURRENCY = 4;

/** The time the client waits beyond the server's bound, for the server's own error to come first. */
const CLIENT_GRACE_MS = 5_000;

/** A drop of one database, given its bound in ms. */
export type DropOne = (database: string, boundMs: number) => Promise<void>;

/** A database that was not dropped, and why. */
export interface DropFailure {
  readonly database: string;
  readonly reason: string;
}

/** What a teardown did: how many were dropped, which leaked. */
export interface DropReport {
  readonly dropped: number;
  readonly leaked: readonly DropFailure[];
}

/** The hook timeout of a teardown of at most `count` databases: every wave of drops at its bound. */
export const teardownTimeout = (count: number, concurrency = DROP_CONCURRENCY): number =>
  Math.ceil(count / concurrency) * (DROP_BOUND_MS + CLIENT_GRACE_MS) + CLIENT_GRACE_MS;

/** `database` dropped on the server of `client`, within `boundMs`, its drop acknowledged by a majority. */
export const dropOnServer =
  (client: MongoClient): DropOne =>
  async (database, boundMs) => {
    await client
      .db(database)
      .dropDatabase({ maxTimeMS: boundMs, writeConcern: { w: "majority", wtimeout: boundMs } });
  };

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** `task`, or a rejection after `ms`. */
async function within(task: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no answer in ${String(ms)} ms`));
    }, ms);
  });
  try {
    await Promise.race([task, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Drops `databases`, at most `concurrency` at once, each within `boundMs`; never rejects. */
export async function dropDatabases(
  databases: readonly string[],
  drop: DropOne,
  options: { readonly boundMs?: number; readonly concurrency?: number } = {},
): Promise<DropReport> {
  const boundMs = options.boundMs ?? DROP_BOUND_MS;
  const queue = [...databases];
  const leaked: DropFailure[] = [];
  let dropped = 0;
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      try {
        await within(drop(next, boundMs), boundMs + CLIENT_GRACE_MS);
        dropped += 1;
      } catch (error) {
        leaked.push({ database: next, reason: describe(error) });
      }
    }
  };
  const width = Math.min(options.concurrency ?? DROP_CONCURRENCY, databases.length);
  await Promise.all(Array.from({ length: width }, worker));
  return { dropped, leaked };
}

/** The report as lines for a log: empty when nothing leaked; else the count and every database by name. */
export function leakLines(report: DropReport): string[] {
  if (report.leaked.length === 0) return [];
  const total = report.dropped + report.leaked.length;
  return [
    `${String(report.leaked.length)} of ${String(total)} test databases leaked (not dropped):`,
    ...report.leaked.map(({ database, reason }) => `  ${database}: ${reason}`),
  ];
}

/** Drops `databases` on `client`'s server and warns of every leak; the leaks, for a test to read. */
export async function teardownDatabases(
  client: MongoClient,
  databases: readonly string[],
): Promise<DropReport> {
  const report = await dropDatabases(databases, dropOnServer(client));
  for (const line of leakLines(report)) process.stderr.write(`${line}\n`);
  return report;
}
