import { StoredNamesUnreadableError } from "@agboss/core/stores";
import type { ExecutionTree, ExecutionTreeValue } from "@agboss/core";
import { describe, expect, it, vi } from "vitest";
import { Collections, MongoExecutionTreeRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/mongodb#105 (agbossjs/agboss#105, acceptance Z): the execution tree store's once-only write. The public
 * `ExecutionTreeRepository.saveIfAbsent(key, value)` is called by user code in any execution of the tree, a child on
 * any instance included, and the child-failure claim of the core's re-entry is written in passes that overlap during a
 * lease takeover: none of those writers holds the root's lease, so the store's own upsert is the only guard. The
 * writers here are instances of their own (a connection each), released together.
 */
const database = testDatabase();

const WRITERS = 4;
const ROUNDS = 8;
const TREE: ExecutionTree = { tenantId: "acme", rootExecutionId: "root-1" };

const treesOn = (url = database.url()) => new MongoExecutionTreeRepository(connectionTo(url));
const keysCollection = () =>
  connectionTo(database.url()).db.collection<{
    _id: string;
    tenantId: string;
    rootExecutionId: string;
    value: string;
  }>(Collections.ExecutionTreeKeys);

describe("agbossjs/mongodb#105: the execution tree store under concurrent writers", () => {
  it("one key saved on several instances at once is saved by exactly one, and its value is kept", async () => {
    const trees = Array.from({ length: WRITERS }, () => treesOn());
    await Promise.all(trees.map((store) => store.ping()));
    for (let round = 0; round < ROUNDS; round += 1) {
      const key = `claim-${String(round)}`;
      let release: () => void = () => undefined;
      const go = new Promise<void>((resolve) => {
        release = resolve;
      });
      const running = trees.map(async (store, index) => {
        await go;
        return store.saveIfAbsentInTree(TREE, key, { writer: index, round });
      });
      release();

      const saved = await Promise.all(running);

      const winners = saved.flatMap((won, index) => (won ? [index] : []));
      expect(winners).toHaveLength(1);
      for (const store of trees)
        expect(await store.findByIdInTree(TREE, key)).toEqual({ writer: winners[0], round });
      expect(await keysCollection().countDocuments({ tenantId: "acme" })).toBe(round + 1);
    }
  });
});

describe("agbossjs/mongodb#105: the execution tree store's keys", () => {
  it("the first save of a key is true and the second is false, and the first value stays", async () => {
    const trees = treesOn();

    expect(await trees.saveIfAbsentInTree(TREE, "once", "first")).toBe(true);
    expect(await trees.saveIfAbsentInTree(TREE, "once", "second")).toBe(false);
    expect(await trees.saveIfAbsentInTree(TREE, "once", "first")).toBe(false);

    expect(await trees.findByIdInTree(TREE, "once")).toBe("first");
  });

  it("a key is its tenant's and its root's own: the same key of another root or tenant is another key", async () => {
    const trees = treesOn();
    const otherRoot: ExecutionTree = { ...TREE, rootExecutionId: "root-2" };
    const otherTenant: ExecutionTree = { ...TREE, tenantId: "globex" };

    expect(await trees.saveIfAbsentInTree(TREE, "same", "mine")).toBe(true);
    expect(await trees.saveIfAbsentInTree(otherRoot, "same", "root")).toBe(true);
    expect(await trees.saveIfAbsentInTree(otherTenant, "same", "tenant")).toBe(true);

    expect(await trees.findByIdInTree(TREE, "same")).toBe("mine");
    expect(await trees.findByIdInTree(otherRoot, "same")).toBe("root");
    expect(await trees.findByIdInTree(otherTenant, "same")).toBe("tenant");
  });

  it("a key that was never saved is undefined; a value that is falsy or null is a value", async () => {
    const trees = treesOn();
    const falsy: ExecutionTreeValue[] = [0, false, "", null, [], {}];
    for (const [index, value] of falsy.entries())
      await trees.saveIfAbsentInTree(TREE, `falsy-${String(index)}`, value);

    expect(await trees.findByIdInTree(TREE, "never")).toBeUndefined();
    for (const [index, value] of falsy.entries())
      expect(await trees.findByIdInTree(TREE, `falsy-${String(index)}`)).toEqual(value);
  });

  it("a nested value comes back as it was saved, a key with U+0000 and a quote in it a key like any", async () => {
    const trees = treesOn();
    const value: ExecutionTreeValue = {
      note: 'say "paid"\u0000',
      list: [1, "two", null, { three: [3] }],
      nested: { "a\u0000b": false },
    };

    expect(await trees.saveIfAbsentInTree(TREE, 'k"\u0000', value)).toBe(true);

    expect(await trees.findByIdInTree(TREE, 'k"\u0000')).toEqual(value);
  });

  it("a key is one document, its value JSON text, in its tenant's and its root's name", async () => {
    await treesOn().saveIfAbsentInTree(TREE, "shape", { a: [1] });

    const stored = await keysCollection().findOne({
      _id: JSON.stringify(["acme", "root-1", "shape"]),
    });

    expect(stored).toEqual({
      _id: JSON.stringify(["acme", "root-1", "shape"]),
      tenantId: "acme",
      rootExecutionId: "root-1",
      value: '{"a":[1]}',
    });
  });

  it("a value that is no JSON is refused, naming what it is and the key, never the text", async () => {
    await keysCollection().insertOne({
      _id: JSON.stringify(["acme", "root-1", "damaged"]),
      tenantId: "acme",
      rootExecutionId: "root-1",
      value: "{not json ssn-078-05-1166",
    });

    const refused = await treesOn()
      .findByIdInTree(TREE, "damaged")
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(StoredNamesUnreadableError);
    expect(refused).toHaveProperty("message", expect.stringContaining("execution tree value"));
    expect(refused).toHaveProperty("message", expect.stringContaining("damaged"));
    expect(refused).toHaveProperty("message", expect.not.stringContaining("ssn-078-05-1166"));
  });
});

describe("agbossjs/mongodb#105: the execution tree store's delete", () => {
  it("deletes every key of its tree and no key of another root or tenant", async () => {
    const trees = treesOn();
    const otherRoot: ExecutionTree = { ...TREE, rootExecutionId: "root-del-2" };
    const otherTenant: ExecutionTree = { ...TREE, tenantId: "globex" };
    const doomed: ExecutionTree = { ...TREE, rootExecutionId: "root-del" };
    for (const tree of [doomed, otherRoot, otherTenant]) {
      await trees.saveIfAbsentInTree(tree, "a", 1);
      await trees.saveIfAbsentInTree(tree, "b", 2);
    }
    const doomedTenantOnRoot: ExecutionTree = { tenantId: "globex", rootExecutionId: "root-del" };
    await trees.saveIfAbsentInTree(doomedTenantOnRoot, "a", 3);

    await trees.deleteAllInTree(doomed);

    expect(await trees.findByIdInTree(doomed, "a")).toBeUndefined();
    expect(await trees.findByIdInTree(doomed, "b")).toBeUndefined();
    expect(await trees.findByIdInTree(otherRoot, "a")).toBe(1);
    expect(await trees.findByIdInTree(otherRoot, "b")).toBe(2);
    expect(await trees.findByIdInTree(otherTenant, "b")).toBe(2);
    expect(await trees.findByIdInTree(doomedTenantOnRoot, "a")).toBe(3);
  });

  it("a deleted tree's key can be saved again; a tree with no key deletes without error", async () => {
    const trees = treesOn();
    const tree: ExecutionTree = { ...TREE, rootExecutionId: "root-again" };
    await trees.deleteAllInTree(tree);
    await trees.saveIfAbsentInTree(tree, "k", "old");

    await trees.deleteAllInTree(tree);

    expect(await trees.saveIfAbsentInTree(tree, "k", "new")).toBe(true);
    expect(await trees.findByIdInTree(tree, "k")).toBe("new");
  });
});

describe("agbossjs/mongodb#105: the execution tree store's ping", () => {
  it("ping is the connection's own ping", async () => {
    const connection = connectionTo(database.url());
    const ping = vi.spyOn(connection, "ping").mockResolvedValue();

    await new MongoExecutionTreeRepository(connection).ping();

    expect(ping).toHaveBeenCalledOnce();
  });
});
