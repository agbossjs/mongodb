import { usd } from "@agboss/core/units";
/**
 * agbossjs/mongodb#104: the commands the direct-message store sends, as the shard's mutants drop their
 * options: a save and a sweep are one transaction (a command of theirs outside it is blind to the
 * transaction's writes and never undone by its abort), the sweep reads ids only and in the order it
 * pages by, and writes nothing when nothing is due; a page's limit is a whole number from 1.
 */
import {
  A2ADirectMessageSaveStatus,
  A2ADirectMessageState,
  type NewA2ADirectMessage,
} from "@agboss/core/stores";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Collections, MongoA2ADirectMessageRepository } from "../../src/index.js";
import { commandsOf, nameOf, plain } from "../support/command-log.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

vi.mock("mongodb", async (importOriginal) => {
  const { reportingCommands } = await import("../support/command-log.js");
  return reportingCommands(await importOriginal());
});

const database = testDatabase();
const NINE = new Date("2026-01-05T09:00:00.000Z");
const at = (seconds: number): Date => new Date(NINE.getTime() + seconds * 1000);
const DIRECT = Collections.A2ADirectMessages;
const CLAIMS = Collections.A2AMessages;

const newMessage = (messageId: string): NewA2ADirectMessage => ({
  endpoint: "orders",
  tenantId: "acme",
  ownerId: "alice",
  messageId,
  requestHash: "h-1",
  skill: "quote",
  contextId: "ctx-1",
  attemptId: `run-${messageId}`,
  startedAt: NINE,
  expiresAt: at(30),
  callsModel: true,
  createdAt: NINE,
});
const keyOf = (messageId: string) => ({ tenantId: "acme", ownerId: "alice", messageId });
const REPLY = { finish: "quote-finish", output: { text: "ok" }, spentUsd: usd(0.01) };

afterEach(async () => {
  const connection = connectionTo(database.url());
  await connection.db.collection(DIRECT).deleteMany({});
  await connection.db.collection(CLAIMS).deleteMany({});
  vi.restoreAllMocks();
});

function setup() {
  const connection = connectionTo(database.url());
  return { connection, store: new MongoA2ADirectMessageRepository(connection) };
}

describe("the store", () => {
  it("is the MongoDB backend", () => {
    expect(MongoA2ADirectMessageRepository.store).toEqual({ backend: "mongodb" });
  });
});

describe("saveIfAbsent is one transaction", () => {
  it("a new message: its document and its claim read, then the claim and the document written, every command inside", async () => {
    const { connection, store } = setup();
    const sent = commandsOf(connection);

    const saved = await store.saveIfAbsent(newMessage("m-1"));

    expect(saved.status).toBe(A2ADirectMessageSaveStatus.Saved);
    expect(sent.map(nameOf)).toEqual([
      `find ${DIRECT}`,
      `find ${CLAIMS}`,
      `delete ${CLAIMS}`,
      `insert ${CLAIMS}`,
      `insert ${DIRECT}`,
    ]);
    expect(sent.map((one) => one.inTransaction)).toEqual([true, true, true, true, true]);
  });

  it("a message already kept: its document read, inside the transaction, nothing written", async () => {
    const { connection, store } = setup();
    await store.saveIfAbsent(newMessage("m-1"));
    const sent = commandsOf(connection);

    const again = await store.saveIfAbsent(newMessage("m-1"));

    expect(again.status).toBe(A2ADirectMessageSaveStatus.Kept);
    expect(sent.map(nameOf)).toEqual([`find ${DIRECT}`]);
    expect(sent[0]?.inTransaction).toBe(true);
  });
});

describe("deleteExpired is one transaction that reads ids only, in its paging order", () => {
  /** A completed message `id` accepted at `NINE`, and one whose document is gone but its claim is not. */
  async function sweepable(store: MongoA2ADirectMessageRepository): Promise<void> {
    await store.saveIfAbsent(newMessage("done-1"));
    await store.completeIfInFlight(keyOf("done-1"), "run-done-1", REPLY, at(5));
    await store.saveIfAbsent(newMessage("orphan-1"));
    await store.deleteIfInFlight(keyOf("orphan-1"), "run-orphan-1");
  }

  it("a completed message and an orphan claim: found, deleted, every command inside one transaction", async () => {
    const { connection, store } = setup();
    await sweepable(store);
    const sent = commandsOf(connection);

    const gone = await store.deleteExpired(new Map([["orders", at(100)]]), 5);

    expect(gone).toBe(1);
    expect(sent.map(nameOf)).toEqual([
      `find ${DIRECT}`,
      `delete ${DIRECT}`,
      `delete ${CLAIMS}`,
      `find ${CLAIMS}`,
      `find ${DIRECT}`,
      `delete ${CLAIMS}`,
    ]);
    expect(sent.every((one) => one.inTransaction)).toBe(true);
  });

  it("what it pages by: the due messages oldest first, the claims by their time, only ids of the claims and of the messages they ask after", async () => {
    const { connection, store } = setup();
    await sweepable(store);
    const sent = commandsOf(connection);

    await store.deleteExpired(new Map([["orders", at(100)]]), 5);

    const [due, , , orphans, held] = sent;
    expect(plain(due?.command.sort)).toEqual({ completedAt: 1, _id: 1 });
    expect(due?.command.limit).toBe(5);
    expect(plain(orphans?.command.projection)).toEqual({ _id: 1 });
    expect(plain(orphans?.command.sort)).toEqual({ savedAt: 1, _id: 1 });
    expect(orphans?.command.limit).toBe(5);
    expect(plain(held?.command.projection)).toEqual({ _id: 1 });
    expect(Object.keys(held?.command.filter as object)).toEqual(["_id"]);
  });

  it("only a completed message is deleted: the delete names the state, and the claim delete the direct claims", async () => {
    const { connection, store } = setup();
    await sweepable(store);
    const sent = commandsOf(connection);

    await store.deleteExpired(new Map([["orders", at(100)]]), 5);

    const deletes = sent.filter((one) => one.name === "delete");
    const [messages, claims, orphans] = deletes.map(
      (one) => (one.command.deletes as { q: Record<string, unknown> }[])[0]?.q ?? {},
    );
    expect(messages).toMatchObject({ state: A2ADirectMessageState.Completed });
    expect(claims).toMatchObject({ taskId: "" });
    expect(orphans).toMatchObject({ taskId: "" });
  });

  it("nothing due and no orphan: three reads and no delete, not even an empty one", async () => {
    const { connection, store } = setup();
    const sent = commandsOf(connection);

    const gone = await store.deleteExpired(new Map([["orders", at(100)]]), 5);

    expect(gone).toBe(0);
    expect(sent.map(nameOf)).toEqual([`find ${DIRECT}`, `find ${CLAIMS}`, `find ${DIRECT}`]);
  });
});

describe("findAllInFlightByExpiresAtBefore", () => {
  it("pages in the order of the expiry, then the id", async () => {
    const { connection, store } = setup();
    const sent = commandsOf(connection);

    await store.findAllInFlightByExpiresAtBefore(at(100), 7);

    expect(sent).toHaveLength(1);
    expect(plain(sent[0]?.command.sort)).toEqual({ expiresAt: 1, _id: 1 });
    expect(sent[0]?.command.limit).toBe(7);
  });
});

describe("a page's limit is a whole number from 1", () => {
  it.each([0, -1, 1.5, Number.NaN])(
    "%s is a RangeError that says so, for a read and for a sweep",
    async (limit) => {
      const { store } = setup();
      const message = `a page of direct A2A messages holds a whole number from 1, not ${String(limit)}`;

      await expect(store.findAllInFlightByExpiresAtBefore(at(1), limit)).rejects.toThrow(
        new RangeError(message),
      );
      await expect(store.deleteExpired(new Map([["orders", at(1)]]), limit)).rejects.toThrow(
        new RangeError(message),
      );
    },
  );
});
