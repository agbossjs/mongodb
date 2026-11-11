import {
  A2ADirectMessageSaveStatus,
  A2ADirectMessageState,
  type NewA2ADirectMessage,
} from "@agboss/core/a2a";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Collections, MongoA2ADirectMessageRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#860 on MongoDB, past the contract: a document read back that is corrupt — or
 * whose state and reply disagree, or whose reply has a field this store does not know — is refused,
 * never read as a message; a save that lost an insert race to a commit is read again, three times
 * at most; and a save of a failed message racing the sweep never leaves a message without its claim.
 */
const database = testDatabase();

const NINE = new Date("2026-01-05T09:00:00.000Z");
const at = (seconds: number): Date => new Date(NINE.getTime() + seconds * 1000);

const newMessage = (messageId: string, extra: Partial<NewA2ADirectMessage> = {}) => ({
  tenantId: "acme",
  ownerId: "alice",
  messageId,
  requestHash: "h-1",
  skill: "quote-workflow-start",
  contextId: "ctx-1",
  attemptId: `run-${messageId}`,
  startedAt: NINE,
  expiresAt: at(30),
  callsModel: true,
  createdAt: NINE,
  ...extra,
});

const storeOn = () => new MongoA2ADirectMessageRepository(connectionTo(database.url()));
const collection = (name: string) => connectionTo(database.url()).db.collection(name);
const keyOf = (messageId: string) => ({ tenantId: "acme", ownerId: "alice", messageId });
afterEach(async () => {
  await collection(Collections.A2ADirectMessages).deleteMany({});
  await collection(Collections.A2AMessages).deleteMany({});
});

const REPLY = { finish: "quote-workflow-finish", output: { text: "ok" }, spentUsd: 0.01 };

describe("agbossjs/agboss#860: a MongoDB direct message read back fails closed", () => {
  it.each([
    ["a field of the wrong type", { $set: { callsModel: "yes" } }],
    ["a completed one without its reply", { $set: { state: A2ADirectMessageState.Completed } }],
    ["one in flight with a reply", { $set: { reply: JSON.stringify(REPLY), completedAt: NINE } }],
  ])("%s is refused", async (_what, change) => {
    const store = storeOn();
    await store.saveIfAbsent(newMessage("m-1"));
    await collection(Collections.A2ADirectMessages).updateOne({ messageId: "m-1" }, change);

    await expect(store.findByKey(keyOf("m-1"))).rejects.toThrow();
  });

  it("a reply with a field this store does not know is refused, never read with it dropped", async () => {
    const store = storeOn();
    await store.saveIfAbsent(newMessage("m-2"));
    await store.completeIfInFlight(keyOf("m-2"), "run-m-2", REPLY, at(5));
    await collection(Collections.A2ADirectMessages).updateOne(
      { messageId: "m-2" },
      { $set: { reply: JSON.stringify({ ...REPLY, grown: 1 }) } },
    );

    await expect(store.findByKey(keyOf("m-2"))).rejects.toThrow(/grown/);
  });
});

describe("agbossjs/agboss#860: a MongoDB direct message's save and the sweep", () => {
  it("a duplicate key from a commit landed in between is read again, at most three times", async () => {
    const store = storeOn();
    const duplicate = Object.assign(new Error("E11000"), { code: 11000 });
    const connection = connectionTo(database.url());
    const again = new MongoA2ADirectMessageRepository(connection);
    const inTransaction = vi.spyOn(connection, "inTransaction").mockRejectedValueOnce(duplicate);

    const save = await again.saveIfAbsent(newMessage("m-3"));
    expect(save.status).toBe(A2ADirectMessageSaveStatus.Saved);
    expect(inTransaction).toHaveBeenCalledTimes(2);

    inTransaction.mockRejectedValue(duplicate);
    await expect(again.saveIfAbsent(newMessage("m-4"))).rejects.toBe(duplicate);
    expect(inTransaction).toHaveBeenCalledTimes(5);
    expect((await store.findByKey(keyOf("m-3")))?.attemptId).toBe("run-m-3");
  });

  it("a failed message saved again while the sweep frees its id: never a message with no claim", async () => {
    const [saver, sweeper] = [storeOn(), storeOn()];
    for (let round = 0; round < 20; round += 1) {
      const messageId = `race-${String(round)}`;
      await saver.saveIfAbsent(newMessage(messageId));
      await saver.deleteIfInFlight(keyOf(messageId), `run-${messageId}`);
      // the resend is accepted at 60 s, the sweep's cutoff at 30 s: the old claim alone is due
      const resend = newMessage(messageId, { attemptId: "run-again", createdAt: at(60) });
      const [save] = await Promise.all([
        saver.saveIfAbsent(resend),
        sweeper.deleteByCreatedAtBefore(at(30), 10),
      ]);

      expect(save.status).toBe(A2ADirectMessageSaveStatus.Saved);
      const claim = await collection(Collections.A2AMessages).findOne({ messageId });
      expect(claim).toMatchObject({ taskId: "", savedAt: at(60) });
    }
  });
});
