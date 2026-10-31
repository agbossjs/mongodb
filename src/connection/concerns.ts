import type { MongoClientOptions, TransactionOptions } from "mongodb";
import { MongoConcernTooWeakError } from "../errors.js";

/**
 * The concerns the stores' guarantees rest on. A lease's epoch, a fenced effect, an outbound call
 * are acknowledged only once a majority of the replica set has them on its journal (`w=majority`,
 * `journal=true`): a failover never rolls them back. Reads see only majority-committed data, from
 * the primary; a transaction reads one snapshot (`snapshot`, or `majority` when chosen).
 */

/** The read concern of the stores' transactions. */
export enum TransactionReadConcern {
  /** One point-in-time snapshot of majority-committed data for the whole transaction (default). */
  Snapshot = "snapshot",
  /** Majority-committed data; the transaction's commit with `w=majority` still makes it atomic. */
  Majority = "majority",
}

/** What the connection sets on its client, whatever the URL leaves out. */
export const ENFORCED_CLIENT_OPTIONS: MongoClientOptions = {
  writeConcern: { w: "majority", journal: true },
  readConcern: { level: "majority" },
  readPreference: "primary",
};

/** A client's concerns as the driver resolved them (`client.writeConcern`, …). */
export interface ClientConcerns {
  readonly writeConcern?: {
    readonly w?: number | string | undefined;
    readonly journal?: boolean | undefined;
  };
  readonly readConcern?: { readonly level?: string | undefined };
  readonly readPreference?: { readonly mode?: string | undefined };
}

/** The read concern levels under which a read never sees a write a failover rolls back. */
const DURABLE_READS: ReadonlySet<string> = new Set(["majority", "snapshot", "linearizable"]);

/** The write concern's weak settings: `w` other than majority, `journal=false`. */
function writeProblemsOf(writeConcern: ClientConcerns["writeConcern"]): string[] {
  const problems: string[] = [];
  const w = writeConcern?.w;
  if (w !== undefined && w !== "majority")
    problems.push(
      `write concern w=${String(w)}: a write acknowledged by fewer than a majority is rolled back on failover — remove w from mongodbUrl (the connection sets w=majority)`,
    );
  if (writeConcern?.journal === false)
    problems.push(
      "journal=false: a write acknowledged before it is on the journal is lost on a crash — remove it from mongodbUrl",
    );
  return problems;
}

/** The reads' weak settings: a read concern under majority, a read preference not the primary. */
function readProblemsOf(concerns: ClientConcerns): string[] {
  const problems: string[] = [];
  const level = concerns.readConcern?.level;
  if (level !== undefined && !DURABLE_READS.has(level))
    problems.push(
      `read concern ${level}: a read can see a write that a failover rolls back — remove readConcernLevel from mongodbUrl (the connection reads at majority)`,
    );
  const mode = concerns.readPreference?.mode;
  if (mode !== undefined && mode !== "primary")
    problems.push(
      `read preference ${mode}: a secondary can be behind the primary — a lease or an effect read there is stale; remove readPreference from mongodbUrl`,
    );
  return problems;
}

/** Each setting of `concerns` that is weaker than the stores need; empty when none. */
export function concernProblemsOf(concerns: ClientConcerns): string[] {
  return [...writeProblemsOf(concerns.writeConcern), ...readProblemsOf(concerns)];
}

/** What is missing from a client that should carry `ENFORCED_CLIENT_OPTIONS`; empty when nothing. */
export function enforcementProblemsOf(concerns: ClientConcerns): string[] {
  const problems: string[] = [];
  if (concerns.writeConcern?.w !== "majority")
    problems.push("the client's write concern is not w=majority");
  if (concerns.writeConcern?.journal !== true)
    problems.push("the client's write concern does not wait for the journal");
  if (concerns.readConcern?.level !== "majority")
    problems.push("the client's read concern is not majority");
  return problems;
}

/** Throws `MongoConcernTooWeakError` naming every problem; nothing when there is none. */
export function requireConcerns(problems: readonly string[]): void {
  if (problems.length > 0) throw new MongoConcernTooWeakError(problems);
}

/** The options of every store transaction: the chosen read concern, `w=majority` on the journal. */
export function transactionOptionsOf(readConcern: TransactionReadConcern): TransactionOptions {
  return {
    readConcern: { level: readConcern },
    writeConcern: { w: "majority", journal: true },
    readPreference: "primary",
  };
}
