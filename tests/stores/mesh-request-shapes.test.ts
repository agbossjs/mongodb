/**
 * The mesh request store's forget and retention as the client sends them (a fake collection, no server).
 */
import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";
import { MongoMeshRequestRepository } from "../../src/index.js";

const dbOf = (collection: object): Db => ({ collection: () => collection }) as never;
const connectionOf = (collection: object) => ({ db: dbOf(collection) }) as never;
const NOW = new Date("2026-01-05T09:00:00.000Z");

describe("the mesh request store's forget and retention", () => {
  const meshOn = (collection: object) => new MongoMeshRequestRepository(connectionOf(collection));
  const KEY = { tenantId: "acme", peer: "p", idempotencyKey: "k" };

  it("a forget answers whether the attempt's request was removed", async () => {
    const removing = (deletedCount: number) =>
      meshOn({ deleteOne: () => Promise.resolve({ deletedCount }) });

    expect(await removing(1).deleteByKey(KEY, "a-1")).toBe(true);
    expect(await removing(0).deleteByKey(KEY, "a-1")).toBe(false);
  });

  it("the retention removes what has expired and is answered or lapsed, and tells how many went", async () => {
    const filters: unknown[] = [];
    const store = meshOn({
      deleteMany: (filter: unknown) => {
        filters.push(filter);
        return Promise.resolve({ deletedCount: 3 });
      },
    });

    expect(await store.deleteExpired(NOW)).toBe(3);

    expect(filters).toStrictEqual([
      {
        expiresAt: { $lte: NOW },
        $or: [{ response: { $exists: true } }, { lockedUntil: { $lte: NOW } }],
      },
    ]);
  });
});
