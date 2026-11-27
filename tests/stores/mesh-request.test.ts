import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collections, MongoMeshRequestRepository } from "../../src/index.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";
import { StoreError } from "@agboss/core/stores";

/**
 * agbossjs/mongodb#105: the mesh request store's once-only claim, raced by instances of their own
 * (a connection each) released together: of N pods admitting one idempotency key exactly one
 * inserts it and runs the request; the first insert's `createdAt` is the one kept.
 */
const database = testDatabase();

const WRITERS = 4;
const HASH = `sha256:${"ab".repeat(32)}`;
const claimOf = (
  attemptId: string,
  createdAt: string,
  lockedUntil: string,
  response?: unknown,
) => ({
  tool: "charge",
  requestHash: HASH,
  createdAt,
  expiresAt: "2026-01-05T09:30:00.000Z",
  attemptId,
  lockedUntil,
  ...(response === undefined ? {} : { response }),
});
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
          ...claimOf(
            `attempt-${String(index)}`,
            new Date(Date.UTC(2026, 0, 5, 9, index)).toISOString(),
            "2026-01-05T09:20:00.000Z",
          ),
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
  const record = {
    ...key,
    ...claimOf("attempt-1", "2026-01-05T09:00:00.000Z", "2026-01-05T09:00:30.000Z"),
  };
  const storeOn = () => new MongoMeshRequestRepository(connectionTo(database.url()));

  it("an answer is kept as written, an answer of nothing as JSON null, told apart from none yet", async () => {
    const store = storeOn();
    await store.saveIfAbsent(record);
    expect(await store.findByKey(key)).not.toHaveProperty("response");

    await store.saveResponse(key, "attempt-1", { tool: "charge", cents: 700 });
    expect((await store.findByKey(key))?.response).toEqual({ tool: "charge", cents: 700 });

    const other = { ...key, idempotencyKey: "k-nothing" };
    await store.saveIfAbsent({ ...record, idempotencyKey: "k-nothing" });
    await store.saveResponse(other, "attempt-1", undefined);
    expect(await store.findByKey(other)).toHaveProperty("response", null);
  });

  it("an answer goes to its own request only", async () => {
    const store = storeOn();
    const other = { ...key, idempotencyKey: "k-other" };
    await store.saveIfAbsent({ ...record, idempotencyKey: "k-other" });
    await store.saveIfAbsent({ ...record, idempotencyKey: "k-mine" });

    await store.saveResponse({ ...key, idempotencyKey: "k-mine" }, "attempt-1", { ok: true });

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

    expect(refused).toBeInstanceOf(StoreError.UnreadableRecord);
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

describe("agbossjs/agboss#1319c: a running mesh request is held by an attempt under a lease", () => {
  // the tests share one key: each starts from no request
  beforeEach(() => emptyAll(database.url()));
  const key = { tenantId: "acme", peer: "orders-application", idempotencyKey: "k-lease" };
  const record = (attemptId: string, createdAt: string, lockedUntil: string) => ({
    ...key,
    ...claimOf(attemptId, createdAt, lockedUntil),
  });
  const storeOn = () => new MongoMeshRequestRepository(connectionTo(database.url()));

  it("only the holder answers, renews or forgets; a stale attempt is fenced", async () => {
    const store = storeOn();
    await store.saveIfAbsent(record("a-1", "2026-01-05T09:00:00.000Z", "2026-01-05T09:00:30.000Z"));

    expect(await store.renewLease(key, "a-2", "2026-01-05T09:01:00.000Z")).toBe(false);
    expect(await store.saveResponse(key, "a-2", { no: true })).toBe(false);
    expect(await store.deleteByKey(key, "a-2")).toBe(false);
    expect(await store.renewLease(key, "a-1", "2026-01-05T09:01:00.000Z")).toBe(true);
    expect((await store.findByKey(key))?.lockedUntil).toBe("2026-01-05T09:01:00.000Z");
    expect(await store.saveResponse(key, "a-1", { ok: true })).toBe(true);
    // answered: neither a second answer nor a renewal
    expect(await store.saveResponse(key, "a-1", { ok: false })).toBe(false);
    expect(await store.renewLease(key, "a-1", "2026-01-05T09:02:00.000Z")).toBe(false);
  });

  it("a lapsed lease is taken over by the same request only; a live one, or another request, is refused", async () => {
    const store = storeOn();
    await store.saveIfAbsent(record("a-1", "2026-01-05T09:00:00.000Z", "2026-01-05T09:00:30.000Z"));

    expect(
      await store.saveIfAbsent(
        record("a-2", "2026-01-05T09:00:10.000Z", "2026-01-05T09:00:40.000Z"),
      ),
    ).toBe(false);
    expect(
      await store.saveIfAbsent({
        ...record("a-3", "2026-01-05T09:00:30.000Z", "2026-01-05T09:01:00.000Z"),
        requestHash: `sha256:${"cd".repeat(32)}`,
      }),
    ).toBe(false);
    expect(
      await store.saveIfAbsent(
        record("a-4", "2026-01-05T09:00:30.000Z", "2026-01-05T09:01:00.000Z"),
      ),
    ).toBe(true);
    expect((await store.findByKey(key))?.attemptId).toBe("a-4");
    // the first attempt is fenced now
    expect(await store.saveResponse(key, "a-1", { stale: true })).toBe(false);
  });

  it("deleteExpired removes an answered request past its expiry and a lapsed one, never a live running one", async () => {
    const store = storeOn();
    const keyed = (idempotencyKey: string) => ({ ...key, idempotencyKey });
    await store.saveIfAbsent({
      ...keyed("answered"),
      ...claimOf("a", "2026-01-05T09:00:00.000Z", "2026-01-05T09:00:30.000Z", { ok: true }),
    });
    await store.saveIfAbsent({
      ...keyed("lapsed"),
      ...claimOf("a", "2026-01-05T09:00:00.000Z", "2026-01-05T09:00:30.000Z"),
    });
    await store.saveIfAbsent({
      ...keyed("running"),
      ...claimOf("a", "2026-01-05T09:00:00.000Z", "2026-01-05T09:40:00.000Z"),
    });

    expect(await store.deleteExpired(new Date("2026-01-05T09:29:59.000Z"))).toBe(0);
    expect(await store.deleteExpired(new Date("2026-01-05T09:30:00.000Z"))).toBe(2);
    expect(await store.findByKey(keyed("answered"))).toBeUndefined();
    expect(await store.findByKey(keyed("lapsed"))).toBeUndefined();
    expect(await store.findByKey(keyed("running"))).toBeDefined();
  });
});
