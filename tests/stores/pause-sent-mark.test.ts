/**
 * agbossjs/mongodb#93: the sent mark of a pause fails closed when the write that records it matches
 * no pause — a miss the transaction's snapshot makes unreachable on a real server, made here by a
 * collection that answers `matchedCount: 0` — and writes nothing else (no notice of a send that was
 * not recorded). Its guard has no `Stryker disable`: this test kills each mutant of it.
 */
import { VirtualClock } from "@agboss/core/testing";
import type { Collection, Db } from "mongodb";
import { beforeEach, describe, expect, it } from "vitest";
import { Collections, MongoPausedExecutionRepository } from "../../src/index.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { pauseOf } from "../support/pauses.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();

beforeEach(() => emptyAll(database.url()));

/** `target[key]`, a method bound to `target`. */
function boundMember(target: object, key: string | symbol): unknown {
  const value: unknown = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
}

describe("agbossjs/mongodb#93: a sent mark that matched no pause", () => {
  it("fails closed, naming what happened, and writes no notice", async () => {
    const connection = connectionTo(database.url());
    const store = new MongoPausedExecutionRepository(connection, new VirtualClock());
    await store.findOrCreateByStepKey(pauseOf("p"));
    const { db } = connection;
    const missing = new Proxy(db, {
      get(target, key) {
        if (key !== "collection") return boundMember(target, key);
        return (...args: Parameters<Db["collection"]>) => {
          const real: Collection = target.collection(...args);
          if (args[0] !== Collections.Pauses) return real;
          return new Proxy(real, {
            get(inner, name) {
              if (name !== "updateOne") return boundMember(inner, name);
              return () => Promise.resolve({ acknowledged: true, matchedCount: 0 });
            },
          });
        };
      },
    });
    Object.defineProperty(connection, "db", { value: missing });

    await expect(
      store.markSentByTenantIdAndPauseId("default", "p", { listeners: ["audit"] }),
    ).rejects.toThrowError(new Error("the sent mark matched no pause"));

    Object.defineProperty(connection, "db", { value: db });
    expect(await db.collection(Collections.PauseNotices).countDocuments()).toBe(0);
    expect(await db.collection(Collections.Pauses).findOne({ pauseId: "p" })).toMatchObject({
      isSent: false,
    });
  });
});
