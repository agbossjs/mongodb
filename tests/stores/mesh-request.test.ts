import { StoredNamesUnreadableError } from "@agboss/core/stores";
import { describe, expect, it, vi } from "vitest";
import { Collections, MongoMeshRequestRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/mongodb#105: the mesh request store's once-only claim, raced by instances of their own
 * (a connection each) released together: of N pods admitting one idempotency key exactly one
 * inserts it and runs the request; the first insert's `createdAt` is the one kept.
 */
const database = testDatabase();

const WRITERS = 4;
const ROUNDS = 8;

describe("agbossjs/mongodb#105: the mesh request store under concurrent writers", () => {
  it("one idempotency key admitted on several instances at once is inserted by exactly one", async () => {
    const stores = Array.from(
      { length: WRITERS },
      () => new MongoMeshRequestRepository(connectionTo(database.url())),
    );
    await Promise.all(stores.map((store) => store.ping()));
    for (let round = 0; round < ROUNDS; round += 1) {
      const idempotencyKey = `key-${String(round)}`;
      let release: () => void = () => undefined;
      const go = new Promise<void>((resolve) => {
        release = resolve;
      });
      const running = stores.map(async (store, index) => {
        await go;
        return store.saveIfAbsent({
          tenantId: "acme",
          peer: "orders-application",
          idempotencyKey,
          createdAt: new Date(Date.UTC(2026, 0, 5, 9, index)).toISOString(),
        });
      });
      release();

      const saved = await Promise.all(running);

      const winners = saved.flatMap((won, index) => (won ? [index] : []));
      expect(winners).toHaveLength(1);
      const stored = await stores[0]?.findByKey({
        tenantId: "acme",
        peer: "orders-application",
        idempotencyKey,
      });
      expect(stored?.createdAt).toBe(
        new Date(Date.UTC(2026, 0, 5, 9, winners[0] ?? -1)).toISOString(),
      );
    }
  });
});

describe("agbossjs/mongodb#105: the mesh request store's answer", () => {
  const key = { tenantId: "acme", peer: "orders-application", idempotencyKey: "k-answer" };
  const record = { ...key, createdAt: "2026-01-05T09:00:00.000Z" };
  const storeOn = () => new MongoMeshRequestRepository(connectionTo(database.url()));

  it("an answer is kept as written, an answer of nothing as JSON null, told apart from none yet", async () => {
    const store = storeOn();
    await store.saveIfAbsent(record);
    expect(await store.findByKey(key)).not.toHaveProperty("response");

    await store.saveResponse(key, { tool: "charge", cents: 700 });
    expect((await store.findByKey(key))?.response).toEqual({ tool: "charge", cents: 700 });

    await store.saveResponse(key, undefined);
    expect(await store.findByKey(key)).toHaveProperty("response", null);
  });

  it("an answer goes to its own request only", async () => {
    const store = storeOn();
    const other = { ...key, idempotencyKey: "k-other" };
    await store.saveIfAbsent({ ...record, idempotencyKey: "k-other" });
    await store.saveIfAbsent({ ...record, idempotencyKey: "k-mine" });

    await store.saveResponse({ ...key, idempotencyKey: "k-mine" }, { ok: true });

    expect(await store.findByKey(other)).not.toHaveProperty("response");
    expect((await store.findByKey({ ...key, idempotencyKey: "k-mine" }))?.response).toEqual({
      ok: true,
    });
  });

  it("an answer that is no JSON is refused, naming what it is and the request's keys, never the text", async () => {
    const store = storeOn();
    await store.saveIfAbsent({ ...record, idempotencyKey: "k-damaged" });
    await connectionTo(database.url())
      .db.collection(Collections.MeshRequests)
      .updateOne({ idempotencyKey: "k-damaged" }, { $set: { response: "{not json" } });

    const refused = await store
      .findByKey({ ...key, idempotencyKey: "k-damaged" })
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(StoredNamesUnreadableError);
    expect(refused).toHaveProperty("message", expect.stringContaining("mesh request response"));
    expect(refused).toHaveProperty("message", expect.stringContaining("orders-application"));
    expect(refused).toHaveProperty("message", expect.stringContaining("k-damaged"));
  });

  it("ping is the connection's own ping", async () => {
    const connection = connectionTo(database.url());
    const ping = vi.spyOn(connection, "ping").mockResolvedValue();

    await new MongoMeshRequestRepository(connection).ping();

    expect(ping).toHaveBeenCalledOnce();
  });
});
