/**
 * agbossjs/mongodb#76, agbossjs/agboss#1017, #1213: the classifier is a whitelist, and a bulk write
 * is known not applied only when every per-operation error is a server reply that proves nothing
 * ran, none of its operations succeeded and no write concern error came with it; a write concern
 * error is never known, whatever its code.
 */
import { StoreOutcomeSource, StoreOutcomeUnknownError } from "@agboss/core/stores";
import {
  MongoBulkWriteError,
  MongoServerError,
  MongoWriteConcernError,
  type BulkWriteResult,
  type WriteConcernError,
  type WriteError,
} from "mongodb";
import { describe, expect, it } from "vitest";
import { settled, writeErrorOf } from "../../src/connection/outcome.js";

interface Applied {
  readonly inserted?: number;
  readonly matched?: number;
  readonly upserted?: number;
  readonly deleted?: number;
  readonly concern?: boolean;
}

/**
 * The driver's result of a bulk write as its error reads it. The driver exports these classes as
 * types only (and builds them itself): the parts the classifier reads are given by shape.
 */
function resultOf(applied: Applied): BulkWriteResult {
  return {
    insertedCount: applied.inserted ?? 0,
    matchedCount: applied.matched ?? 0,
    modifiedCount: 0,
    upsertedCount: applied.upserted ?? 0,
    deletedCount: applied.deleted ?? 0,
    getWriteConcernError: () => (applied.concern === true ? concernOf(91) : undefined),
  } as BulkWriteResult;
}

const concernOf = (code: number): WriteConcernError =>
  ({ code, errmsg: "not acknowledged" }) as WriteConcernError;

const perOperation = (code: number, index: number): WriteError =>
  ({ code, index, errmsg: "refused" }) as WriteError;

const bulkError = (codes: readonly number[], applied: Applied = {}): MongoBulkWriteError =>
  new MongoBulkWriteError(
    {
      message: "bulk",
      code: 65,
      writeErrors: codes.map((code, index) => perOperation(code, index)),
    },
    resultOf(applied),
  );

describe("a bulk write that is known not applied", () => {
  it.each([
    ["one duplicate key", [11000]],
    ["a duplicate key of every kind and a write conflict", [11000, 11001, 12582, 112]],
    ["a validation failure and a refusal of the form", [121, 2, 9, 14, 40]],
  ])("%s: rethrown as it is", (_name, codes) => {
    const error = bulkError(codes);

    expect(writeErrorOf("coll.bulkWrite", error)).toBe(error);
  });
});

describe("a bulk write that is unknown", () => {
  it.each([
    ["one operation's error of no known code", [999_999]],
    ["one known and one unknown operation", [11000, 999_999]],
    ["an unknown and then a known operation", [999_999, 11000]],
    ["an operation's code that Unauthorized (13) is", [13]],
    ["no per-operation error at all", []],
  ])("%s", (_name, codes) => {
    const error = bulkError(codes);
    const read = writeErrorOf("coll.bulkWrite", error);

    expect(read).toBeInstanceOf(StoreOutcomeUnknownError);
    expect(read).toMatchObject({
      store: "MongoConnection",
      operation: "coll.bulkWrite",
      source: StoreOutcomeSource.Transport,
      cause: error,
    });
  });

  it.each([
    ["inserted", { inserted: 1 }],
    ["matched", { matched: 1 }],
    ["upserted", { upserted: 1 }],
    ["deleted", { deleted: 1 }],
    ["inserted and matched (a sum, not a difference)", { inserted: 1, matched: 1 }],
    ["inserted and upserted", { inserted: 1, upserted: 1 }],
    ["inserted and deleted", { inserted: 1, deleted: 1 }],
    ["matched and deleted", { matched: 1, deleted: 1 }],
  ] satisfies (readonly [string, Applied])[])(
    "some of its operations %s before the failing one",
    (_name, applied) => {
      const error = bulkError([11000], applied);

      expect(writeErrorOf("coll.bulkWrite", error)).toBeInstanceOf(StoreOutcomeUnknownError);
    },
  );

  it("it met a write concern error of its result", () => {
    const error = bulkError([11000], { concern: true });

    expect(error.err).toBeUndefined();
    expect(writeErrorOf("coll.bulkWrite", error)).toBeInstanceOf(StoreOutcomeUnknownError);
  });

  it("it carries a write concern error of its own", () => {
    const error = bulkError([11000]);
    error.err = concernOf(91);

    expect(writeErrorOf("coll.bulkWrite", error)).toBeInstanceOf(StoreOutcomeUnknownError);
  });
});

describe("a write concern error is never known, whatever its code", () => {
  it.each([2, 9, 14, 40, 112, 121, 11_000, 11_001, 12_582])("code %i", (code) => {
    const error = new MongoWriteConcernError({ ok: 1, writeConcernError: { code, errmsg: "x" } });
    const read = writeErrorOf("coll.insertOne", error);

    expect(error.code).toBe(code);
    expect(read).toBeInstanceOf(StoreOutcomeUnknownError);
    expect(read).toMatchObject({ cause: error });
  });
});

describe("settled: a single-command write", () => {
  it("answers what the write answered", async () => {
    await expect(settled("coll.insertOne", () => Promise.resolve("done"))).resolves.toBe("done");
  });

  it("rethrows an error that proves nothing was applied as it is", async () => {
    const dup = new MongoServerError({ message: "dup", code: 11000 });

    await expect(settled("coll.insertOne", () => Promise.reject(dup))).rejects.toBe(dup);
  });

  it("reads every other error as unknown, naming the operation", async () => {
    const boom = new Error("reset");
    const error = await settled("coll.insertOne", () => Promise.reject(boom)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(StoreOutcomeUnknownError);
    expect(error).toMatchObject({ operation: "coll.insertOne", cause: boom });
  });
});
