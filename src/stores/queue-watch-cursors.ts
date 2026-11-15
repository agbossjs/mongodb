import type { Clock } from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import type { CommandSucceededEvent, Db, Long, MongoClient } from "mongodb";
import { closeBounded } from "../connection/close-bounded.js";
import { Collections } from "../connection/collections.js";

/**
 * The server-side cursors of the queue watch's streams (agbossjs/agboss#1088): a stream dropped as
 * dead cannot tell the server to drop its cursor (its one connection is the dead one), so the
 * watch remembers the ids and kills them over a connection that answers.
 */

/** A server-side cursor: its id and the namespace it belongs to, nothing of what it returned. */
export interface Cursor {
  readonly id: Long;
  readonly ns: string;
}

/** A cursor of a stream that was dropped, and the generation of that stream. */
export interface Orphan extends Cursor {
  readonly generation: number;
}

/**
 * Collects the cursors `client` opens. Only the id and the namespace are read from an `aggregate`
 * or a `getMore` reply — the reply carries documents, and neither it nor the command is kept or
 * logged. `unlisten` ends it (the client's close).
 */
export function listenForCursors(client: MongoClient): {
  readonly cursors: Cursor[];
  readonly unlisten: () => void;
} {
  const cursors: Cursor[] = [];
  const heard = (event: CommandSucceededEvent): void => {
    if (event.commandName !== "aggregate" && event.commandName !== "getMore") return;
    const cursor = (event.reply as { cursor?: { id?: Long; ns?: string } } | undefined)?.cursor;
    const { id, ns } = cursor ?? {};
    if (id === undefined || ns === undefined || id.isZero()) return;
    if (!cursors.some((known) => known.id.equals(id))) cursors.push({ id, ns });
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
  db: Db,
  orphans: readonly Orphan[],
  current: number | undefined,
  clock: Clock,
  warn: (message: string) => void,
  grace?: Milliseconds,
): Promise<void> {
  const ns = `${db.databaseName}.${Collections.ChildExecutionQueue}`;
  const cursors = orphans
    .filter((orphan) => orphan.ns === ns && orphan.generation !== current)
    .map((orphan) => orphan.id);
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
