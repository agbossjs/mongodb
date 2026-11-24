/**
 * agbossjs/agboss#1166 (#1121, #906 D4-b): every other read of a stored text that is no JSON is the
 * coded `StoredNamesUnreadableError` (`code: "stored.unreadable"`, the record, the ids of its row)
 * and quotes no stored text — not in the message, the stack or the cause. A site that goes back to a
 * bare `JSON.parse` fails its case: the parser's `SyntaxError` quotes the secret and has no code.
 * The documents are given to the stores' readers as a database would give them; no server is asked.
 */
import { inspect } from "node:util";
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { StoredNamesUnreadableError } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import { fillMissingChannels } from "../../src/connection/pause-channels.js";
import { directMessageOf } from "../../src/stores/a2a-direct-messages/a2a-direct-message-documents.js";
import { messageOf, taskOf } from "../../src/stores/a2a-tasks/a2a-task-documents.js";
import { auditEventOf } from "../../src/stores/audit-log/audit-event-documents.js";
import { replayOf } from "../../src/stores/fenced-effects/result-documents.js";
import { MongoExecutionTreeRepository } from "../../src/stores/mongo-execution-tree.repository.js";
import { MongoMeshRequestRepository } from "../../src/stores/mongo-mesh-request.repository.js";

const SECRET = "ssn-078-05-1166";
const TEXTS = [
  `{"startInput":{"name":"${SECRET}"},"x":undefined}`,
  SECRET,
  `{"startInput":{"name":${SECRET}}}`,
];

const date = new Date("2026-01-05T09:00:00.000Z");

/** The error `read` throws or rejects with. */
async function thrownBy(read: () => unknown): Promise<unknown> {
  return Promise.resolve()
    .then(read)
    .then(
      () => new Error("it was read"),
      (thrown: unknown) => thrown,
    );
}

async function refused(read: () => unknown, record: string, ids: string): Promise<void> {
  const error = await thrownBy(read);
  expect(error).toBeInstanceOf(StoredNamesUnreadableError);
  expect(error).toMatchObject({ code: "stored.unreadable", record, ids });
  if (!(error instanceof Error)) throw new TypeError("no error");
  expect(error.cause).toBeInstanceOf(SyntaxError);
  const shown = inspect(error, { depth: 12 });
  expect(shown).not.toContain(SECRET);
  expect(shown).not.toMatch(/startInput|Unexpected|JSON\.parse/);
}

/** A connection whose one collection answers `document` to a `findOne`. */
const connectionOf = (document: unknown) => ({
  db: { collection: () => ({ findOne: () => Promise.resolve(document) }) },
});

describe.each(TEXTS)("a stored text that is not JSON: %#", (text) => {
  it("an a2a task's status, and an a2a message's reply", async () => {
    const task = {
      endpoint: "orders",
      tenantId: "default",
      taskId: "task-1",
      ownerId: "",
      contextId: "c-1",
      skill: "s",
      state: "TASK_STATE_WORKING",
      status: text,
      version: 1,
      acceptedAt: date,
      statusAt: date,
    };
    const message = {
      endpoint: "orders",
      tenantId: "default",
      ownerId: "",
      messageId: "message-1",
      requestHash: "h",
      taskId: "task-1",
      savedAt: date,
      reply: text,
    };

    await refused(() => taskOf(task), "a2a task status", "taskId task-1");
    await refused(() => messageOf(message), "a2a message reply", "messageId message-1");
  });

  it("an a2a direct message's reply", async () => {
    const document = {
      endpoint: "orders",
      tenantId: "default",
      ownerId: "",
      messageId: "message-1",
      requestHash: "h",
      skill: "s",
      contextId: "c-1",
      state: "completed",
      attemptId: "a-1",
      startedAt: date,
      expiresAt: date,
      callsModel: false,
      createdAt: date,
      reply: text,
      completedAt: date,
    };

    await refused(
      () => directMessageOf(document),
      "a2a direct message reply",
      "messageId message-1",
    );
  });

  it("an audit event's record", async () => {
    await refused(() => auditEventOf({ record: text }), "execution audit event", "");
  });

  it("a fenced effect's stored result", async () => {
    const key = effectKeyForTesting({
      scopeKey: "default:root-1",
      tenantId: "default",
      leaseExecutionId: "root-1",
      token: 1,
      idempotencyKey: "root-1:charge-action:1",
      name: "charge",
    });

    await refused(
      () => replayOf(key, { token: 1, result: text, storedAt: date }),
      "fenced effect result",
      "name charge",
    );
  });

  it("an execution tree's value", async () => {
    const trees = new MongoExecutionTreeRepository(connectionOf({ value: text }) as never);

    await refused(
      () => trees.findByIdInTree({ tenantId: "default", rootExecutionId: "root-1" }, "k1"),
      "execution tree value",
      "key k1",
    );
  });

  it("a mesh request's response", async () => {
    const document = {
      tenantId: "default",
      peer: "peer-1",
      idempotencyKey: "key-1",
      tool: "charge",
      requestHash: "h",
      createdAt: date,
      expiresAt: date,
      attemptId: "a-1",
      lockedUntil: date,
      response: text,
    };
    const mesh = new MongoMeshRequestRepository(connectionOf(document) as never);

    await refused(
      () => mesh.findByKey({ tenantId: "default", peer: "peer-1", idempotencyKey: "key-1" }),
      "mesh request response",
      "peer peer-1, idempotencyKey key-1",
    );
  });

  it("a pause whose channel the migration fills from its record", async () => {
    const cursor = {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield { _id: "p1", record: text };
      },
    };
    const db = { collection: () => ({ find: () => cursor, updateOne: () => Promise.resolve() }) };

    await refused(() => fillMissingChannels(db as never, {}), "pause", "");
  });
});
