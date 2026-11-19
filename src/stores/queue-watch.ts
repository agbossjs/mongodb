import { CLOSE_GRACE, closeBounded, closeClientBounded } from "../connection/close-bounded.js";
import { watchLiveness } from "../connection/heartbeat.js";
import type { MongoConnection } from "../connection/mongodb-connection.js";
import { watchClientOf } from "../connection/watch-client.js";
import type { ChildExecutionQueueWatch, Clock } from "@agboss/core";
import { seconds, type Milliseconds } from "@agboss/core/units";
import type { ChangeStream, Db, MongoClient } from "mongodb";
import { awaitFor, startAfter, PAUSES, QUEUED_CHANGES } from "./queue-changes.js";
import { Collections } from "../connection/collections.js";
import {
  awaitAnswer,
  killDropped,
  listenForStream,
  type Cursor,
  type Orphan,
} from "./queue-watch-cursors.js";

/**
 * The child queue's watch on MongoDB (agbossjs/agboss#777): a change stream on the queue's
 * collection, every document that becomes `queued` — inserted so, or set so by a resume or a lost
 * claim's requeue — waking the claimers. The stream starts just after the cluster time of a `ping`
 * sent before `open` resolves, so a child queued once the watch is open is never missed while the
 * server starts the stream, and one queued before is not replayed (the watch wakes for it only
 * as the catch-up of a reopen, once; agbossjs/agboss#1028). Idle on an empty queue: the server holds each `getMore` up to
 * a quarter of the liveness bound (one idle round trip per instance per 2.5 s, no document read). The driver resumes a
 * stream after a resumable error on its own; a stream that closes otherwise is opened again after a
 * pause that doubles from 1 s up to 30 s on the application's `Clock`, and wakes the claimers once
 * (a child queued meanwhile). The replica set the stores require gives the change streams.
 *
 * It runs on a client of its own (`watchClientOf`) and notices a connection that dies silently — a
 * half-open TCP connection behind a NAT or a load balancer: no FIN, no RST, and the driver itself
 * takes 40 s to see it — within the liveness bound (agbossjs/agboss#789): a `ping` every half of
 * it, the answer due within the other half. A client that does not answer is dropped, `warn` says
 * so, and the stream is opened on a new client, then wakes once, as after any loss.
 */

/** One stream, its client and the end of its ping. */
interface OpenStream {
  /** Which stream of the watch this is: a stream is heard only while it is the current one. */
  readonly generation: number;
  readonly client: MongoClient;
  readonly db: Db;
  readonly stream: ChangeStream;
  /** The server-side cursors the stream's client has opened (the driver may resume with a new one). */
  readonly cursors: Cursor[];
  /** Ends the client's command events: the id and namespace are all they are read for. */
  readonly unlisten: () => void;
  /** Settles once the stream's `aggregate` calls are answered (their cursors' ids are then in `cursors`), or the liveness bound has passed. */
  readonly answered: () => Promise<void>;
  /** How long the stream's server holds a `getMore` (a close's `killCursors` waits for the one in flight). */
  readonly holdsFor: Milliseconds;
  readonly beat: AbortController;
}

export class MongoQueueWatch implements ChildExecutionQueueWatch {
  readonly #stopped = new AbortController();
  #open: OpenStream | undefined;
  #generations = 0;
  #reopening: Promise<void> | undefined;
  /** Cursors of streams dropped as dead, still to be killed on the server. */
  #orphans: Orphan[] = [];

  private constructor(
    private readonly connection: MongoConnection,
    private readonly clock: Clock,
    private readonly warn: (message: string) => void,
    private readonly onQueued: () => void,
  ) {}

  /** Watches now; rejects when the deployment does not answer (the caller tries again later). */
  static async open(
    connection: MongoConnection,
    clock: Clock,
    warn: (message: string) => void,
    onQueued: () => void,
  ): Promise<MongoQueueWatch> {
    const watch = new MongoQueueWatch(connection, clock, warn, onQueued);
    await watch.#start();
    return watch;
  }

  async close(): Promise<void> {
    this.#stopped.abort();
    const open = this.#open;
    this.#open = undefined;
    open?.beat.abort();
    await this.#reopening;
    await this.#reap();
    if (open !== undefined) await this.#closeAndKill(open);
  }

  async #start(): Promise<void> {
    const { client, db, livenessSeconds } = watchClientOf(this.connection, {
      monitorCommands: true,
    });
    const { cursors, answered, unlisten } = listenForStream(client, this.warn);
    const attempt = new AbortController();
    try {
      const startAtOperationTime = await Promise.race([
        db.command({ ping: 1 }).then(startAfter),
        this.#unanswered(livenessSeconds, AbortSignal.any([attempt.signal, this.#stopped.signal])),
      ]);
      const stream = db.collection(Collections.ChildExecutionQueue).watch(QUEUED_CHANGES, {
        maxAwaitTimeMS: awaitFor(livenessSeconds),
        ...(startAtOperationTime === undefined ? {} : { startAtOperationTime }),
      });
      this.#generations += 1;
      const open = {
        generation: this.#generations,
        client,
        db,
        stream,
        cursors,
        unlisten,
        answered: () => awaitAnswer(answered, this.clock, seconds(livenessSeconds)),
        holdsFor: awaitFor(livenessSeconds),
        beat: new AbortController(),
      };
      // a stream dropped as dead is closed, but its driver may still deliver what was in flight, or
      // resume it once connections go through again: only the current stream is heard
      // (agbossjs/agboss#1051)
      stream.on("change", () => {
        if (this.#isCurrent(open)) this.onQueued();
      });
      stream.on("error", (error) => {
        this.#lost(open, `its change stream failed: ${error.message}`);
      });
      stream.on("close", () => {
        this.#lost(open, "its change stream closed");
      });
      if (this.#stopped.signal.aborted) {
        await this.#closeAndKill(open);
        return;
      }
      this.#open = open;
      void this.#heartbeat(open, livenessSeconds);
    } catch (error) {
      unlisten();
      void closeClientBounded(client, this.clock);
      throw error;
    } finally {
      attempt.abort();
    }
  }

  /** Rejects when `livenessSeconds` have passed on the clock (the server is silent) or `signal` aborts. */
  async #unanswered(livenessSeconds: number, signal: AbortSignal): Promise<never> {
    await this.clock.sleep(seconds(livenessSeconds), signal);
    throw new Error("the deployment did not answer in time");
  }

  /** Pings until the stream is replaced; a client that does not answer is lost. */
  async #heartbeat(open: OpenStream, livenessSeconds: number): Promise<void> {
    const dead = await watchLiveness({
      clock: this.clock,
      livenessSeconds,
      ping: () => open.client.db().command({ ping: 1 }),
      signal: open.beat.signal,
    });
    if (dead !== undefined) this.#lost(open, dead);
  }

  /** Whether `open` is the stream the watch listens to (not one it dropped, nor one not yet adopted). */
  #isCurrent(open: OpenStream): boolean {
    return !this.#stopped.signal.aborted && this.#open?.generation === open.generation;
  }

  /**
   * Closes the stream, then its client, each bounded on the clock: a silent connection never lets
   * either finish, and neither may hold the stop. In this order (agbossjs/agboss#1088): the
   * client has one connection (`maxPoolSize: 1`), and its close shuts the pool, so a stream closed
   * at the same time loses its `killCursors` and its cursor stays on the server until
   * `cursorTimeoutMillis` (10 min). If the stream's close does not end within the bound (the
   * server cannot be reached: a black hole), the client is closed all the same, and the cursor is
   * then the server's to reap: nothing in the process can still tell the server to drop it.
   */
  async #closeStream(open: OpenStream): Promise<void> {
    // the stream's connection is busy with a `getMore` the server holds up to `holdsFor`, and the
    // `killCursors` of the close takes its turn behind it
    await closeBounded(
      () => open.stream.close(),
      this.clock,
      seconds((CLOSE_GRACE + open.holdsFor) / 1000),
    );
    open.unlisten();
    await closeClientBounded(open.client, this.clock);
  }

  /**
   * The stop's close of the current stream (agbossjs/agboss#1345). The stream's own close is not
   * trusted to have dropped its cursor: its `killCursors` may still be queued behind a slow
   * `getMore` when the bound passes and the client's sockets go, or the driver may end its close
   * without sending one for a cursor it had not yet taken. The cursors the stream opened are killed
   * by id over a client made for it, as a dropped stream's are, so a stop ends with them closed
   * whenever the server answers.
   */
  async #closeAndKill(open: OpenStream): Promise<void> {
    // an `aggregate` still in flight tells its cursor's id only in its reply, and the close of the
    // client drops the sockets: wait for it, as long as the watch waits for any answer (past that
    // bound the server is taken as dead, and nothing in the process can learn the id)
    await open.answered();
    await this.#closeStream(open);
    // by id whatever the stream's own close did: it may end without the server having dropped the
    // cursor (its `killCursors` still queued, or never sent for a cursor it had not yet taken), and
    // a cursor already gone answers `cursorsNotFound`, which is no failure
    this.#orphans.push(
      ...open.cursors.map((cursor) => ({ ...cursor, generation: open.generation })),
    );
    await this.#reap();
  }

  /** The stream failed, closed or went silent: open another, unless the watch is closed or it was replaced. */
  #lost(open: OpenStream, reason: string): void {
    if (!this.#isCurrent(open)) return;
    this.#open = undefined;
    open.beat.abort();
    this.warn(`The child queue's change stream is lost (${reason}); opening it again`);
    // closed, not just left: the driver resumes a stream on its own once connections go through
    // again, and a silent client never finishes an orderly close, so it is left to end by itself
    this.#orphans.push(
      ...open.cursors.map((cursor) => ({ ...cursor, generation: open.generation })),
    );
    void this.#closeStream(open);
    this.#reopening = this.#reopen().finally(() => {
      this.#reopening = undefined;
    });
  }

  async #reopen(): Promise<void> {
    const signal = this.#stopped.signal;
    const isStopped = (): boolean => signal.aborted;
    for (let attempt = 0; ; attempt += 1) {
      const pause = PAUSES[Math.min(attempt, PAUSES.length - 1)] ?? seconds(30);
      await this.clock.sleep(pause, signal).catch(() => undefined);
      if (isStopped()) return;
      if (await this.#started()) {
        if (this.#open !== undefined) this.onQueued();
        await this.#reap();
        return;
      }
    }
  }

  /**
   * Kills the cursors of the dropped streams on the server, by id, over a client made for it and
   * closed after, bounded on the clock. Not over the stream's client: its one connection carries
   * the liveness ping, and a kill queued there would delay the proof the watch lives on. A dropped
   * stream whose connection went silent can never tell the server itself (its one connection is
   * the dead one); a server that cannot be reached now keeps the cursor until `cursorTimeoutMillis`
   * ends it (10 min), and nothing here can change that (agbossjs/agboss#1088).
   */
  async #reap(): Promise<void> {
    if (this.#orphans.length === 0) return;
    const { client, db, livenessSeconds } = watchClientOf(this.connection);
    // a client made now connects first (it has half the liveness bound for that), then answers
    const grace = seconds(livenessSeconds / 2 + CLOSE_GRACE / 1000);
    try {
      const orphans = this.#orphans.splice(0);
      await killDropped(db, orphans, this.#open?.generation, this.clock, this.warn, grace);
    } finally {
      await closeClientBounded(client, this.clock);
    }
  }

  async #started(): Promise<boolean> {
    try {
      await this.#start();
      return true;
    } catch {
      return false;
    }
  }
}
