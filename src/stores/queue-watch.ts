import { closeBounded } from "../connection/close-bounded.js";
import { watchLiveness } from "../connection/heartbeat.js";
import type { MongoConnection } from "../connection/mongodb-connection.js";
import { watchClientOf } from "../connection/watch-client.js";
import type { ChildExecutionQueueWatch, Clock } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import type { ChangeStream, MongoClient } from "mongodb";
import { awaitFor, clusterTimeOf, PAUSES, QUEUED_CHANGES } from "./queue-changes.js";
import { Collections } from "../connection/collections.js";

/**
 * The child queue's watch on MongoDB (agbossjs/agboss#777): a change stream on the queue's
 * collection, every document that becomes `queued` — inserted so, or set so by a resume or a lost
 * claim's requeue — waking the claimers. The stream starts at the cluster time of a `ping` sent
 * before `open` resolves, so a child queued once the watch is open is never missed while the
 * server starts the stream. Idle on an empty queue: the server holds each `getMore` up to
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
  readonly client: MongoClient;
  readonly stream: ChangeStream;
  readonly beat: AbortController;
}

export class MongoQueueWatch implements ChildExecutionQueueWatch {
  readonly #stopped = new AbortController();
  #open: OpenStream | undefined;
  #reopening: Promise<void> | undefined;

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
    if (open !== undefined) await closeBounded(() => open.client.close(), this.clock);
  }

  async #start(): Promise<void> {
    const { client, db, livenessSeconds } = watchClientOf(this.connection);
    const attempt = new AbortController();
    try {
      const startAtOperationTime = await Promise.race([
        db.command({ ping: 1 }).then(clusterTimeOf),
        this.#unanswered(livenessSeconds, AbortSignal.any([attempt.signal, this.#stopped.signal])),
      ]);
      const stream = db.collection(Collections.ChildExecutionQueue).watch(QUEUED_CHANGES, {
        maxAwaitTimeMS: awaitFor(livenessSeconds),
        ...(startAtOperationTime === undefined ? {} : { startAtOperationTime }),
      });
      const open = { client, stream, beat: new AbortController() };
      stream.on("change", () => {
        this.onQueued();
      });
      stream.on("error", (error) => {
        this.#lost(open, `its change stream failed: ${error.message}`);
      });
      stream.on("close", () => {
        this.#lost(open, "its change stream closed");
      });
      if (this.#stopped.signal.aborted) {
        await closeBounded(() => client.close(), this.clock);
        return;
      }
      this.#open = open;
      void this.#heartbeat(open, livenessSeconds);
    } catch (error) {
      void closeBounded(() => client.close(), this.clock);
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

  /** The stream failed, closed or went silent: open another, unless the watch is closed or it was replaced. */
  #lost(open: OpenStream, reason: string): void {
    if (this.#stopped.signal.aborted || this.#open !== open) return;
    this.#open = undefined;
    open.beat.abort();
    this.warn(`The child queue's change stream is lost (${reason}); opening it again`);
    // a silent client never finishes an orderly close: it is left to end by itself
    void closeBounded(() => open.client.close(), this.clock);
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
        return;
      }
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
