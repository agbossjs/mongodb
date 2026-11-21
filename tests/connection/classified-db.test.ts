/**
 * agbossjs/agboss#1017, agbossjs/mongodb#76, #1213: the collections of `classifiedDb` read the error
 * of a write outside a transaction that proves nothing was applied as it is and every other as
 * `StoreOutcomeUnknownError`, naming the collection and the write; a write of an open transaction,
 * a read and anything else of the database are left as they are. The driver's methods are stubbed:
 * no server is asked.
 */
import { StoreOutcomeSource, StoreOutcomeUnknownError } from "@agboss/core/stores";
import { Collection, Db, MongoClient, MongoServerError, type ClientSession } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifiedDb } from "../../src/connection/classified-db.js";

/** Every write method and the position of its options (where `session` is). */
const WRITES: readonly (readonly [string, number])[] = [
  ["insertOne", 1],
  ["insertMany", 1],
  ["updateOne", 2],
  ["updateMany", 2],
  ["replaceOne", 2],
  ["deleteOne", 1],
  ["deleteMany", 1],
  ["findOneAndUpdate", 2],
  ["findOneAndReplace", 2],
  ["findOneAndDelete", 1],
  ["bulkWrite", 1],
];

const MANY: ReadonlySet<string> = new Set(["updateMany", "deleteMany"]);
const duplicate = (): MongoServerError => new MongoServerError({ message: "dup", code: 11000 });
const client = new MongoClient("mongodb://127.0.0.1:1");
// made in a test, not at the import (see framework-json.test.ts)
const collectionOf = (): ReturnType<ReturnType<typeof classifiedDb>["collection"]> =>
  classifiedDb(client.db("app")).collection("orders");

/** The write of the classified collection, called with `args`. */
function write(method: string, args: unknown[]): Promise<unknown> {
  const collection = collectionOf();
  const member: unknown = Reflect.get(collection, method);
  if (typeof member !== "function") throw new TypeError(`${method} is no method`);
  return Reflect.apply(member, collection, args) as Promise<unknown>;
}

/** The driver's method of `Collection`, failing with `error` when it is called. */
function failing(method: string, error: unknown): void {
  const stub = function failingMethod(): Promise<never> {
    return Promise.reject(error instanceof Error ? error : new Error("stub"));
  };
  vi.spyOn(Collection.prototype, method as "insertOne").mockImplementation(stub);
}

/** A session of an open transaction (no command is sent to start one). */
function transaction(): ClientSession {
  const session = client.startSession();
  session.startTransaction();
  return session;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifiedDb: a write outside a transaction", () => {
  it.each(WRITES)(
    "%s: an error that proves nothing is unknown, naming the collection and the write",
    async (method) => {
      const boom = new Error("connection reset");
      failing(method, boom);

      const error = await write(method, []).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(StoreOutcomeUnknownError);
      expect(error).toMatchObject({
        operation: `orders.${method}`,
        source: StoreOutcomeSource.Transport,
        cause: boom,
      });
    },
  );

  it.each(WRITES.filter(([method]) => !MANY.has(method)))(
    "%s: a duplicate key of one document is rethrown as it is",
    async (method) => {
      const dup = duplicate();
      failing(method, dup);

      await expect(write(method, [])).rejects.toBe(dup);
    },
  );

  it.each([...MANY])(
    "%s: a duplicate key of many documents proves nothing: unknown",
    async (method) => {
      failing(method, duplicate());

      await expect(write(method, [])).rejects.toBeInstanceOf(StoreOutcomeUnknownError);
    },
  );

  it("a write with options that name no session is read as outside a transaction", async () => {
    failing("insertOne", new Error("reset"));

    await expect(write("insertOne", [{}, {}])).rejects.toBeInstanceOf(StoreOutcomeUnknownError);
  });

  it("a write whose options are null is read as outside a transaction", async () => {
    failing("insertOne", new Error("reset"));

    await expect(write("insertOne", [{}, null])).rejects.toBeInstanceOf(StoreOutcomeUnknownError);
  });

  it("a write whose session is undefined is read as outside a transaction", async () => {
    failing("insertOne", new Error("reset"));

    await expect(write("insertOne", [{}, { session: undefined }])).rejects.toBeInstanceOf(
      StoreOutcomeUnknownError,
    );
  });

  it("a write whose session has no transaction open is outside one", async () => {
    failing("insertOne", new Error("reset"));
    const session = client.startSession();

    await expect(write("insertOne", [{}, { session }])).rejects.toBeInstanceOf(
      StoreOutcomeUnknownError,
    );
  });
});

describe("classifiedDb: a write of an open transaction", () => {
  it.each(WRITES)(
    "%s: its error is left as it is, the commit decides",
    async (method, optionsAt) => {
      const boom = new Error("connection reset");
      failing(method, boom);
      const args: unknown[] = Array.from({ length: optionsAt }, () => ({}));
      args.push({ session: transaction() });

      await expect(write(method, args)).rejects.toBe(boom);
    },
  );
});

describe("classifiedDb: what is not a write", () => {
  it("a read's error is left as it is, whatever it is", async () => {
    const boom = new Error("connection reset");
    failing("findOne", boom);

    await expect(write("findOne", [{}])).rejects.toBe(boom);
  });

  it("the collection keeps its other members", () => {
    expect(collectionOf().collectionName).toBe("orders");
  });

  it("a method of the database that is not `collection` is the driver's own, called on the database", async () => {
    const raw = client.db("app");
    const command = vi.spyOn(Db.prototype, "command").mockResolvedValue({ ok: 1 });

    const reply = await classifiedDb(raw).command({ ping: 1 });

    expect(reply).toEqual({ ok: 1 });
    expect(command).toHaveBeenCalledWith({ ping: 1 });
    expect(command.mock.contexts[0]).toBe(raw);
  });

  it("the database keeps its other methods and members", () => {
    const db = classifiedDb(client.db("app"));

    expect(db.databaseName).toBe("app");
    expect(db.collection("other").collectionName).toBe("other");
  });
});
