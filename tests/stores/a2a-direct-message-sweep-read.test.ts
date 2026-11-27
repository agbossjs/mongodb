/**
 * The direct-message sweep reads every due message through its schema (a fake collection, no server).
 */
import type { Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { sweptIn } from "../../src/stores/a2a-direct-messages/a2a-direct-message-sweep.js";

const dbOf = (collection: object): Db => ({ collection: () => collection }) as never;
const NOW = new Date("2026-01-05T09:00:00.000Z");

describe("the direct-message sweep", () => {
  it("the direct-message sweep reads every due message through its schema: a corrupt one fails the sweep, never vanishes unread", async () => {
    const cursor = { toArray: () => Promise.resolve([{ _id: "damaged", state: 7 }]) };
    const db = dbOf({ find: () => cursor, deleteMany: vi.fn() });

    await expect(sweptIn(db, undefined as never, new Map([["orders", NOW]]), 10)).rejects.toThrow();
  });
});
