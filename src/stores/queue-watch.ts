import { ExecutionRecordStatus, type ChildExecutionQueueWatch, type Clock } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { Timestamp, type ChangeStream, type Collection, type Db, type Document } from "mongodb";

/**
 * The child queue's watch on MongoDB (agbossjs/agboss#777): a change stream on the queue's
 * collection, every document that becomes `queued` — inserted so, or set so by a resume or a lost
 * claim's requeue — waking the claimers. The stream starts at the cluster time of a `ping` sent
 * before `open` resolves, so a child queued once the watch is open is never missed while the
 * server starts the stream. Idle on an empty queue: the server holds each `getMore` up to
 * `AWAIT_FOR` (one idle round trip per instance per 10 s, no document read). The driver resumes a
 * stream after a resumable error on its own; a stream that closes otherwise is opened again after a
 * pause that doubles from 1 s up to 30 s on the application's `Clock`, and wakes the claimers once
 * (a child queued meanwhile). The replica set the stores require gives the change streams.
 */

/** How long the server holds an idle `getMore` of the stream. */
const AWAIT_FOR = seconds(10);
/** The pauses before each attempt to open the stream again; the last one repeats. */
const PAUSES = [1, 2, 4, 8, 16, 30].map((pause) => seconds(pause));

/** The changes that queue a child: only their ids leave the server. */
const QUEUED_CHANGES: Document[] = [
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

const clusterTimeOf = (reply: Document): Timestamp | undefined => {
  const time: unknown = reply.operationTime;
  return time instanceof Timestamp ? time : undefined;
};

export class MongoQueueWatch implements ChildExecutionQueueWatch {
  readonly #stopped = new AbortController();
  #stream: ChangeStream | undefined;
  #reopening: Promise<void> | undefined;

  private constructor(
    private readonly db: Db,
    private readonly queue: Collection,
    private readonly clock: Clock,
    private readonly onQueued: () => void,
  ) {}

  /** Watches now; rejects when the deployment does not answer (the caller tries again later). */
  static async open(
    db: Db,
    queue: Collection,
    clock: Clock,
    onQueued: () => void,
  ): Promise<MongoQueueWatch> {
    const watch = new MongoQueueWatch(db, queue, clock, onQueued);
    await watch.#start();
    return watch;
  }

  async close(): Promise<void> {
    this.#stopped.abort();
    const stream = this.#stream;
    this.#stream = undefined;
    await this.#reopening;
    await stream?.close().catch(() => undefined);
  }

  async #start(): Promise<void> {
    const startAtOperationTime = clusterTimeOf(await this.db.command({ ping: 1 }));
    const stream = this.queue.watch(QUEUED_CHANGES, {
      maxAwaitTimeMS: AWAIT_FOR,
      ...(startAtOperationTime === undefined ? {} : { startAtOperationTime }),
    });
    stream.on("change", () => {
      this.onQueued();
    });
    stream.on("error", () => {
      this.#lost(stream);
    });
    stream.on("close", () => {
      this.#lost(stream);
    });
    if (this.#stopped.signal.aborted) {
      await stream.close().catch(() => undefined);
      return;
    }
    this.#stream = stream;
  }

  /** The stream failed or closed: open another, unless the watch is closed or it was replaced. */
  #lost(stream: ChangeStream): void {
    if (this.#stopped.signal.aborted || this.#stream !== stream) return;
    this.#stream = undefined;
    void stream.close().catch(() => undefined);
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
        if (this.#stream !== undefined) this.onQueued();
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
