import {
  A2ATaskRepository,
  A2ATaskSaveStatus,
  Injectable,
  type A2AMessageKey,
  type A2AMessageRecord,
  type A2ATaskKey,
  type A2ATaskPage,
  type A2ATaskQuery,
  type A2ATaskRecord,
  type A2ATaskSave,
  type A2ATaskStatus,
  type NewA2ATask,
} from "@agboss/core";
import type { ClientSession, Collection, Db } from "mongodb";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import {
  messageDocumentOf,
  messageIdOf,
  messageOf,
  replyTextOf,
  taskDocumentOf,
  taskIdOf,
  taskOf,
  TERMINAL_STATES,
  type A2AMessageDocument,
  type A2ATaskDocument,
} from "./a2a-tasks/a2a-task-documents.js";
import { savedOrKept } from "./a2a-tasks/a2a-message-save.js";
import { pageOf } from "./a2a-tasks/a2a-task-pages.js";
import { sweptTerminalBefore } from "./a2a-tasks/a2a-task-sweep.js";
import { DUPLICATE_KEY, hasCode } from "./keys.js";

/** How often an accept that lost an insert race to a commit is read again (then it rejects). */
const ACCEPT_ATTEMPTS = 3;

const tasksOf = (db: Db): Collection<A2ATaskDocument> =>
  db.collection<A2ATaskDocument>(Collections.A2ATasks);
const messagesOf = (db: Db): Collection<A2AMessageDocument> =>
  db.collection<A2AMessageDocument>(Collections.A2AMessages);

/**
 * `A2ATaskRepository` on MongoDB (agbossjs/agboss#824): the A2A tasks an application serves, shared
 * by every instance on the replica set — a message resent to any pod finds the task it was accepted
 * for, `GetTask` on any pod reads it. One document per task and one per accepted message, each
 * `_id` its key (`keys.ts`), the status and a reply as JSON text.
 *
 * - `saveIfAbsent` is one transaction (`inTransaction`: snapshot reads, `w=majority`): it reads the
 *   message and the task id, then inserts both. Of two pods accepting one message the second's
 *   insert of the message `_id` is a write conflict — the driver runs its transaction again, which
 *   then reads the winner's message and task — or, the winner committed first, a duplicate key,
 *   which is read again here. A task id another message's task has saves nothing.
 * - `compareAndSetStatus` is one `findOneAndUpdate` on `_id`, `version` and a state not terminal:
 *   of two writers at one version exactly one matches; a terminal status is never written over.
 * - `saveMessageIfAbsent` is one upsert with `$setOnInsert`, or the read of the message kept
 *   (upserted again when the sweep removed it in between: never "saved" for a message not stored);
 *   `saveReplyIfAbsent` one update of a message without a reply.
 * - `list` reads the page and its count (`countDocuments`) in two commands: a task saved in
 *   between moves the count by one, as the next page would show it.
 * - `deleteTerminalByStatusAtBefore` removes the finished tasks in bounded batches, outside a
 *   transaction (a backlog of any size outlives no transaction's lifetime): each batch's tasks, then
 *   their messages. A terminal status never changes, so a batch read is still due when deleted; a
 *   crash between the two leaves messages whose task is gone, which a resend reads as accepted
 *   before (`MessageTaken`, no task) — never a second task within retention.
 *
 * Listed in `@Application({ providers })` with `mongodbUrl`.
 */
@Injectable({ deps: [MongoConnection] })
export class MongoA2ATaskRepository extends A2ATaskRepository {
  static override readonly backend: string | undefined = "mongodb";

  constructor(private readonly connection: MongoConnection) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async saveIfAbsent(task: NewA2ATask): Promise<A2ATaskSave> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.connection.inTransaction(({ session, db }) =>
          acceptedIn(db, session, task),
        );
      } catch (error) {
        // a commit of the same key landed before this transaction's insert: read it again
        if (!hasCode(error, DUPLICATE_KEY) || attempt >= ACCEPT_ATTEMPTS) throw error;
      }
    }
  }

  saveMessageIfAbsent(message: A2AMessageRecord): Promise<A2AMessageRecord | undefined> {
    return savedOrKept(messagesOf(this.connection.db), message);
  }

  async saveReplyIfAbsent(key: A2AMessageKey, reply: unknown): Promise<boolean> {
    const saved = await messagesOf(this.connection.db).updateOne(
      { _id: messageIdOf(key), reply: { $exists: false } },
      { $set: { reply: replyTextOf(reply) } },
    );
    return saved.modifiedCount === 1;
  }

  async findById(key: A2ATaskKey): Promise<A2ATaskRecord | undefined> {
    const found = await tasksOf(this.connection.db).findOne({ _id: taskIdOf(key) });
    return found === null ? undefined : taskOf(found);
  }

  async findByMessage(key: A2AMessageKey): Promise<A2AMessageRecord | undefined> {
    const found = await messagesOf(this.connection.db).findOne({ _id: messageIdOf(key) });
    return found === null ? undefined : messageOf(found);
  }

  async compareAndSetStatus(
    key: A2ATaskKey,
    expectedVersion: number,
    status: A2ATaskStatus,
    statusAt: Date,
  ): Promise<A2ATaskRecord | undefined> {
    const written = await tasksOf(this.connection.db).findOneAndUpdate(
      { _id: taskIdOf(key), version: expectedVersion, state: { $nin: [...TERMINAL_STATES] } },
      {
        $set: { state: status.state, status: JSON.stringify(status), statusAt },
        $inc: { version: 1 },
      },
      { returnDocument: "after" },
    );
    return written === null ? undefined : taskOf(written);
  }

  list(query: A2ATaskQuery): Promise<A2ATaskPage> {
    return pageOf(tasksOf(this.connection.db), query);
  }

  async deleteTerminalByStatusAtBefore(cutoff: Date): Promise<void> {
    await sweptTerminalBefore(this.connection.db, cutoff);
  }
}

/** One attempt of `saveIfAbsent`, inside its transaction. */
async function acceptedIn(db: Db, session: ClientSession, task: NewA2ATask): Promise<A2ATaskSave> {
  const kept = await messagesOf(db).findOne({ _id: messageIdOf(task) }, { session });
  if (kept !== null) {
    const message = messageOf(kept);
    const found = await tasksOf(db).findOne(
      { _id: taskIdOf({ tenantId: message.tenantId, taskId: message.taskId }) },
      { session },
    );
    return {
      status: A2ATaskSaveStatus.MessageTaken,
      message,
      task: found === null ? undefined : taskOf(found),
    };
  }
  if ((await tasksOf(db).countDocuments({ _id: taskIdOf(task) }, { session, limit: 1 })) > 0)
    return { status: A2ATaskSaveStatus.TaskIdTaken };
  const record: A2ATaskRecord = {
    tenantId: task.tenantId,
    taskId: task.taskId,
    ownerId: task.ownerId,
    contextId: task.contextId,
    skill: task.skill,
    status: task.status,
    version: 1,
    acceptedAt: task.acceptedAt,
    statusAt: task.acceptedAt,
    ...(task.callerPeer === undefined ? {} : { callerPeer: task.callerPeer }),
  };
  await messagesOf(db).insertOne(messageDocumentOf({ ...task, savedAt: task.acceptedAt }), {
    session,
  });
  await tasksOf(db).insertOne(taskDocumentOf(record), { session });
  return { status: A2ATaskSaveStatus.Saved, task: record };
}
