/**
 * agbossjs/agboss#824 on MongoDB: an A2A message whose upsert finds a document the retention sweep
 * removes before it is read is upserted again — and when that happens twice the call rejects: the
 * store never answers "saved" (`undefined`) for a message it did not store. The collection's
 * commands are scripted for the race; nothing is written.
 */
import { describe, expect, it, vi } from "vitest";
import { Collections } from "../../src/index.js";
import type { A2AMessageDocument } from "../../src/stores/a2a-tasks/a2a-task-documents.js";
import { savedOrKept } from "../../src/stores/a2a-tasks/a2a-message-save.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();

const MESSAGE = {
  tenantId: "default",
  ownerId: "alice",
  messageId: "m-1",
  requestHash: "h-1",
  taskId: "t-1",
  savedAt: new Date("2026-01-05T09:00:00.000Z"),
};

/** The messages' collection, its upserts answering `upserted` in turn and its reads none. */
function scripted(...upserted: readonly number[]) {
  const messages = connectionTo(database.url()).db.collection<A2AMessageDocument>(
    Collections.A2AMessages,
  );
  const updateOne = vi.spyOn(messages, "updateOne");
  for (const count of upserted)
    updateOne.mockResolvedValueOnce({
      acknowledged: true,
      matchedCount: 1 - count,
      modifiedCount: 0,
      upsertedCount: count,
      upsertedId: null,
    });
  vi.spyOn(messages, "findOne").mockResolvedValue(null);
  return { messages, updateOne };
}

describe("agbossjs/agboss#824: a MongoDB message saved, or the one kept", () => {
  it("a conflicting document gone before it was read: upserted again, this call saved it", async () => {
    const { messages, updateOne } = scripted(0, 1);

    expect(await savedOrKept(messages, MESSAGE)).toBeUndefined();
    expect(updateOne).toHaveBeenCalledTimes(2);
  });

  it("gone twice: rejects, never answers saved", async () => {
    const { messages } = scripted(0, 0);

    await expect(savedOrKept(messages, MESSAGE)).rejects.toThrow(/gone, twice: nothing is saved/);
  });
});
