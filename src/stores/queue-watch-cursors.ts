import type { Clock } from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import {
  Long,
  type CommandFailedEvent,
  type CommandStartedEvent,
  type CommandSucceededEvent,
  type Db,
  type MongoClient,
} from "mongodb";
import { closeBounded } from "../connection/close-bounded.js";
import { Collections } from "../connection/collections.js";

/**
 * The server-side cursors of the queue watch's streams (agbossjs/agboss#1088): a stream dropped as
 * dead cannot tell the server to drop its cursor (its one connection is the dead one), so the
 * watch remembers the ids and kills them over a connection that answers.
 */

/**
 * A server-side cursor: its id and the namespace it belongs to, nothing of what it returned. The id
 * is a `bigint`, whatever the driver delivered (agbossjs/agboss#1169).
 */
export interface Cursor {
  readonly id: bigint;
  readonly ns: string;
}

/**
 * The id of a cursor as a `bigint`, from what the driver's reply holds: a `Long` (the default for an
 * id of 54 bits or more), a `number` (`promoteLongs`, the default, turns an id of 53 bits or less
 * into one: about one id in 500), or a `bigint` (`useBigInt64=true` in the URL). Anything else is
 * not an id: `undefined`.
 */
export function cursorIdOf(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  if (Long.isLong(value)) return BigInt(value.toString());
  return undefined;
}

/** A cursor of a stream that was dropped, and the generation of that stream. */
export interface Orphan extends Cursor {
  readonly generation: number;
}

/** What the listener needs of a client: its command events. */
export interface CommandEvents {
  on(event: "commandSucceeded", listener: (event: CommandSucceededEvent) => void): unknown;
  off(event: "commandSucceeded", listener: (event: CommandSucceededEvent) => void): unknown;
}

/** The open cursor an `aggregate` or a `getMore` reply names (not a closed one, id 0), if any. */
function openedBy(event: CommandSucceededEvent): Cursor | undefined {
  if (event.commandName !== "aggregate" && event.commandName !== "getMore") return undefined;
  const cursor = (event.reply as { cursor?: { id?: unknown; ns?: unknown } } | undefined)?.cursor;
  const id = cursorIdOf(cursor?.id);
  const ns = cursor?.ns;
  return id === undefined || id === 0n || typeof ns !== "string" ? undefined : { id, ns };
}

/**
 * Collects the cursors `client` opens. Only the id and the namespace are read from an `aggregate`
 * or a `getMore` reply — the reply carries documents, and neither it nor the command is kept or
 * logged. `unlisten` ends it (the client's close). It runs inside the driver's `emit`, on the
 * command's own path: it never throws, whatever the reply holds; a reply it cannot read is
 * warned about once (the error's name, nothing of the reply) and the cursor goes unrecorded.
 */
export function listenForCursors(
  client: CommandEvents,
  warn: (message: string) => void = () => undefined,
): {
  readonly cursors: Cursor[];
  readonly unlisten: () => void;
} {
  const cursors: Cursor[] = [];
  let warned = false;
  const heard = (event: CommandSucceededEvent): void => {
    try {
      const cursor = openedBy(event);
      if (cursor !== undefined && !cursors.some((known) => known.id === cursor.id))
        cursors.push(cursor);
    } catch (error) {
      if (warned) return;
      warned = true;
      const name = error instanceof Error ? error.name : typeof error;
      warn(
        `The child queue's cursor listener could not read a command reply (${name}); a cursor of its change stream may stay on the server until it times out`,
      );
    }
  };
  client.on("commandSucceeded", heard);
  return {
    cursors,
    unlisten: () => {
      client.off("commandSucceeded", heard);
    },
  };
}

/**
 * `killCursors` for the orphans that belong to the queue collection of `db` and to a stream other
 * than the current one (`current`, a generation), each on its own namespace. Never fatal: a
 * failure, or no answer within `grace` (the close bound) on `clock`, is warned about once, with the error's
 * code, and not tried again; the server then drops the cursor once it times out (10 min).
 */
export async function killDropped(
  db: Pick<Db, "databaseName" | "command">,
  orphans: readonly Orphan[],
  current: number | undefined,
  clock: Clock,
  warn: (message: string) => void,
  grace?: Milliseconds,
): Promise<void> {
  const ns = `${db.databaseName}.${Collections.ChildExecutionQueue}`;
  const cursors = orphans
    .filter((orphan) => orphan.ns === ns && orphan.generation !== current)
    .map((orphan) => Long.fromBigInt(orphan.id));
  if (cursors.length === 0) return;
  const state = { answered: false };
  let reported = false;
  const report = (why: string): void => {
    if (reported) return;
    reported = true;
    warn(
      `The child queue's dropped change stream's cursor could not be killed on the server (${why}); the server drops it once it times out`,
    );
  };
  await closeBounded(
    async () => {
      try {
        await db.command({ killCursors: Collections.ChildExecutionQueue, cursors });
      } catch (error) {
        const code = (error as { code?: number | string }).code;
        report(`error ${code === undefined ? "without a code" : String(code)}`);
      } finally {
        state.answered = true;
      }
    },
    clock,
    grace,
  );
  if (!state.answered) report("no answer within the close bound");
}

/**
 * Whether the stream's `aggregate` calls are answered (agbossjs/agboss#1345): the stream's first
 * one, which the driver sends when it has a connection, and any it sends to resume. The reply of an
 * `aggregate` that the server runs is the only place its cursor's id is told, and a client whose
 * sockets go before the reply never learns it: the cursor stays on the server until it times out
 * (10 min). A stop therefore waits for this, within a bound, before it closes the stream. `unlisten` ends it.
 */
export function listenForAggregates(client: Pick<MongoClient, "on" | "off">): {
  readonly answered: () => Promise<void>;
  readonly unlisten: () => void;
} {
  let first = false;
  let inFlight = 0;
  const waiting = new Set<() => void>();
  const settle = (): void => {
    if (!first || inFlight > 0) return;
    for (const wake of waiting) wake();
    waiting.clear();
  };
  const started = (event: CommandStartedEvent): void => {
    if (event.commandName === "aggregate") inFlight += 1;
  };
  const ended = (event: CommandSucceededEvent | CommandFailedEvent): void => {
    if (event.commandName !== "aggregate") return;
    first = true;
    inFlight = Math.max(0, inFlight - 1);
    settle();
  };
  client.on("commandStarted", started);
  client.on("commandSucceeded", ended);
  client.on("commandFailed", ended);
  return {
    answered: () =>
      first && inFlight === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiting.add(resolve);
          }),
    unlisten: () => {
      client.off("commandStarted", started);
      client.off("commandSucceeded", ended);
      client.off("commandFailed", ended);
      settle();
      for (const wake of waiting) wake();
      waiting.clear();
    },
  };
}

/** What a watch's client lets it learn of its cursors: the ids they carry and when their `aggregate`s are answered. */
export function listenForStream(
  client: Pick<MongoClient, "on" | "off">,
  warn: (message: string) => void,
): {
  readonly cursors: Cursor[];
  readonly answered: () => Promise<void>;
  readonly unlisten: () => void;
} {
  const heard = listenForCursors(client, warn);
  const aggregates = listenForAggregates(client);
  return {
    cursors: heard.cursors,
    answered: aggregates.answered,
    unlisten: () => {
      heard.unlisten();
      aggregates.unlisten();
    },
  };
}

/** Waits until `answered` settles or `bound` passes on `clock`, whichever is first. */
export async function awaitAnswer(
  answered: () => Promise<void>,
  clock: Clock,
  bound: Milliseconds,
): Promise<void> {
  const waiting = new AbortController();
  try {
    await Promise.race([answered(), clock.sleep(bound, waiting.signal).catch(() => undefined)]);
  } finally {
    waiting.abort();
  }
}
