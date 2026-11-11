import { Injectable, type StoreDescriptor } from "@agboss/core";
import {
  A2ADirectMessageRepository,
  A2ADirectMessageState,
  type A2ADirectMessageAttempt,
  type A2ADirectMessageKey,
  type A2ADirectMessageRecord,
  type A2ADirectMessageReply,
  type A2ADirectMessageSave,
  type NewA2ADirectMessage,
} from "@agboss/core/stores";
import { MongoConnection } from "../connection/mongodb-connection.js";
import {
  directIdOf,
  directMessageOf,
  replyTextOf,
} from "./a2a-direct-messages/a2a-direct-message-documents.js";
import { directMessagesOf, directSavedIn } from "./a2a-direct-messages/a2a-direct-message-save.js";
import { sweptIn } from "./a2a-direct-messages/a2a-direct-message-sweep.js";
import { DUPLICATE_KEY, hasCode } from "./keys.js";

/** How often a save that lost an insert race to a commit is read again (then it rejects). */
const SAVE_ATTEMPTS = 3;

/** A page's limit, checked: a whole number from 1, so a sweep's paging always ends. */
function checkedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError(
      `a page of direct A2A messages holds a whole number from 1, not ${String(limit)}`,
    );
  return limit;
}

/**
 * `A2ADirectMessageRepository` on MongoDB (agbossjs/agboss#860): the replies of the direct-reply
 * skills, shared by every instance on the replica set. One document per message in
 * `agboss_a2a_direct_messages`, `_id` its tenant, owner and message id; its id claimed in the A2A
 * task store's `agboss_a2a_messages` under the same `_id`, a claim of no task (`taskId` `""`) — so
 * a task message and a direct message of one id are never both kept: both insert that `_id`.
 *
 * - `saveIfAbsent` is one transaction (`inTransaction`, as `MongoA2ATaskRepository`'s accept):
 *   the document kept, else the claim read and written, then the document inserted
 *   (`a2a-direct-message-save.ts`). Of two saves of one message the later conflicts and, run
 *   again, reads the winner's document (`Kept`); a duplicate key from a commit landed in between
 *   is read again here.
 * - `completeIfInFlight`, `retakeIfExpired` (also `expiresAt <= now`, the caller's clock) and
 *   `deleteIfInFlight` are each one conditional command on `_id`, the state and the attempt id: of
 *   two writers exactly one matches. A removed message's claim stays until the sweep.
 * - `deleteByCreatedAtBefore` is one transaction of at most `limit` messages and `limit` claims
 *   (`a2a-direct-message-sweep.ts`).
 *
 * Listed in `@Application({ providers })` beside `MongoA2ATaskRepository`, with `mongodbUrl`.
 */
@Injectable({ deps: [MongoConnection] })
export class MongoA2ADirectMessageRepository extends A2ADirectMessageRepository {
  static override readonly store: StoreDescriptor = { backend: "mongodb" };

  constructor(private readonly connection: MongoConnection) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async saveIfAbsent(message: NewA2ADirectMessage): Promise<A2ADirectMessageSave> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.connection.inTransaction(({ session, db }) =>
          directSavedIn(db, session, message),
        );
      } catch (error) {
        // a commit of the same key landed before this transaction's insert: read it again
        if (!hasCode(error, DUPLICATE_KEY) || attempt >= SAVE_ATTEMPTS) throw error;
      }
    }
  }

  async findByKey(key: A2ADirectMessageKey): Promise<A2ADirectMessageRecord | undefined> {
    const found = await this.#messages.findOne({ _id: directIdOf(key) });
    return found === null ? undefined : directMessageOf(found);
  }

  async completeIfInFlight(
    key: A2ADirectMessageKey,
    attemptId: string,
    reply: A2ADirectMessageReply,
    completedAt: Date,
  ): Promise<A2ADirectMessageRecord | undefined> {
    const written = await this.#messages.findOneAndUpdate(
      { _id: directIdOf(key), state: A2ADirectMessageState.InFlight, attemptId },
      { $set: { state: A2ADirectMessageState.Completed, reply: replyTextOf(reply), completedAt } },
      { returnDocument: "after" },
    );
    return written === null ? undefined : directMessageOf(written);
  }

  async retakeIfExpired(
    key: A2ADirectMessageKey,
    expiredAttemptId: string,
    next: A2ADirectMessageAttempt,
    now: Date,
  ): Promise<A2ADirectMessageRecord | undefined> {
    const written = await this.#messages.findOneAndUpdate(
      {
        _id: directIdOf(key),
        state: A2ADirectMessageState.InFlight,
        attemptId: expiredAttemptId,
        expiresAt: { $lte: now },
      },
      {
        $set: { attemptId: next.attemptId, startedAt: next.startedAt, expiresAt: next.expiresAt },
      },
      { returnDocument: "after" },
    );
    return written === null ? undefined : directMessageOf(written);
  }

  async deleteIfInFlight(key: A2ADirectMessageKey, attemptId: string): Promise<boolean> {
    const removed = await this.#messages.deleteOne({
      _id: directIdOf(key),
      state: A2ADirectMessageState.InFlight,
      attemptId,
    });
    return removed.deletedCount === 1;
  }

  async findAllInFlightByExpiresAtBefore(
    now: Date,
    limit: number,
  ): Promise<readonly A2ADirectMessageRecord[]> {
    const found = await this.#messages
      .find(
        { state: A2ADirectMessageState.InFlight, expiresAt: { $lte: now } },
        { sort: { expiresAt: 1, _id: 1 }, limit: checkedLimit(limit) },
      )
      .toArray();
    return found.map(directMessageOf);
  }

  async deleteByCreatedAtBefore(
    cutoff: Date,
    limit: number,
  ): Promise<readonly A2ADirectMessageRecord[]> {
    const checked = checkedLimit(limit);
    return this.connection.inTransaction(({ session, db }) =>
      sweptIn(db, session, cutoff, checked),
    );
  }

  get #messages() {
    return directMessagesOf(this.connection.db);
  }
}
