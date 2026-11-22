/**
 * agbossjs/mongodb#82 (a follow-up of #76): the three guards of the write classifier that no other
 * test proved. Each case fails when its guard is removed (the sabotages are in the PR):
 *  - a write concern error is unknown whatever its code, also a code the whitelist knows;
 *  - a bulk write that applied something and then failed on known codes is unknown;
 *  - a command of a transaction is left to the driver although its failure ended the transaction
 *    (the state is read before the call).
 */
import { StoreOutcomeUnknownError } from "@agboss/core/stores";
import {
  Collection,
  MongoBulkWriteError,
  MongoClient,
  MongoServerError,
  MongoWriteConcernError,
  type AnyBulkWriteOperation,
} from "mongodb";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MongoConnection } from "../../src/index.js";
import { writeErrorOf } from "../../src/connection/outcome.js";
import { emptyAll, openConnection, testDatabase } from "../support/database.js";
import { holdFailPoints } from "../support/failpoint-lock.js";

const APP = "agboss-write-outcome-guards-test";
const PROBE = "write_outcome_guards_probe";
const database = testDatabase();
holdFailPoints();
let started: MongoConnection | undefined;
let adminClient: MongoClient | undefined;

const live = (): MongoConnection => {
  if (started === undefined) throw new Error("the connection is made by the first test's hook");
  return started;
};
const admin = (): MongoClient => {
  if (adminClient === undefined) throw new Error("the client is made by the first test's hook");
  return adminClient;
};

// made in the first test's hook, not in a `beforeAll`: a mutant of the connection that fails here must fail a
// test, which kills it, not the file's setup, which Stryker leaves out of the score (agbossjs/mongodb#103)
beforeEach(async () => {
  started ??= await openConnection(`${database.url()}&appName=${APP}`);
  adminClient ??= new MongoClient(database.url());
  await emptyAll(database.url(), [PROBE]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await admin().db("admin").command({ configureFailPoint: "failCommand", mode: "off" });
});

afterAll(async () => {
  await started?.onDestroy();
  await adminClient?.close();
});

interface Probe {
  _id: string;
  x?: number;
}

const probe = (): Collection<Probe> => live().db.collection(PROBE);

/** Every code the whitelist knows, for a single write or only for a form refusal. */
const KNOWN_CODES = [2, 9, 14, 40, 112, 121, 11000, 11001, 12582] as const;

const concernError = (code: number): MongoWriteConcernError =>
  new MongoWriteConcernError({ ok: 1, writeConcernError: { code, errmsg: "concern" } });

describe("a write concern error is unknown whatever its code (the write may have been applied)", () => {
  it.each(KNOWN_CODES)(
    "code %i of a write concern error is unknown, not the server's refusal",
    (code) => {
      const error = concernError(code);

      expect(error.code).toBe(code);
      expect(writeErrorOf("coll.insertOne", error)).toBeInstanceOf(StoreOutcomeUnknownError);
      expect(writeErrorOf("coll.updateMany", error, true)).toBeInstanceOf(StoreOutcomeUnknownError);
    },
  );

  it.each([11000, 2])(
    "the server applied an insert and answered a write concern error with code %i: unknown",
    async (code) => {
      await admin()
        .db("admin")
        .command({
          configureFailPoint: "failCommand",
          mode: { times: 2 },
          data: {
            failCommands: ["insert"],
            appName: APP,
            writeConcernError: { code, errmsg: "a known code, a write concern error" },
          },
        });

      const failure: unknown = await probe()
        .insertOne({ _id: "applied" })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StoreOutcomeUnknownError);
      expect(failure).toMatchObject({ cause: { code } });
      expect((failure as StoreOutcomeUnknownError).cause).toBeInstanceOf(MongoWriteConcernError);
      await admin().db("admin").command({ configureFailPoint: "failCommand", mode: "off" });
      // the connection reads at majority: its snapshot may trail the write by a moment
      await vi.waitFor(async () => {
        expect(await probe().countDocuments({ _id: "applied" })).toBe(1);
      });
    },
  );
});

describe("a bulk write that applied something and then failed on known codes is unknown", () => {
  /** The first operation applies, the second is refused with a duplicate key (11000): unordered, so both are tried. */
  const CASES: readonly (readonly [string, readonly AnyBulkWriteOperation<Probe>[], string])[] = [
    ["inserted", [{ insertOne: { document: { _id: "new" } } }], "insertedCount"],
    [
      "matched",
      [{ updateOne: { filter: { _id: "seed" }, update: { $set: { x: 1 } } } }],
      "matchedCount",
    ],
    [
      "upserted",
      [{ updateOne: { filter: { _id: "up" }, update: { $set: { x: 1 } }, upsert: true } }],
      "upsertedCount",
    ],
    ["deleted", [{ deleteOne: { filter: { _id: "seed" } } }], "deletedCount"],
  ];

  it.each(CASES)(
    "%s: the server applied it, so the batch is unknown",
    async (_name, applied, counter) => {
      await probe().insertMany([{ _id: "seed" }, { _id: "dup" }]);

      const failure: unknown = await probe()
        .bulkWrite([...applied, { insertOne: { document: { _id: "dup" } } }], { ordered: false })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StoreOutcomeUnknownError);
      const cause = (failure as StoreOutcomeUnknownError).cause;
      expect(cause).toBeInstanceOf(MongoBulkWriteError);
      // every refusal is a known code and something really was applied
      expect((cause as MongoBulkWriteError).writeErrors).toMatchObject([{ code: 11000 }]);
      expect((cause as MongoBulkWriteError)[counter as keyof MongoBulkWriteError]).toBe(1);
    },
  );
});

describe("a command of a transaction is left to the driver although its failure ended the transaction", () => {
  const transient = (): MongoServerError => {
    const error = new MongoServerError({ message: "no such transaction", code: 251 });
    error.addErrorLabel("TransientTransactionError");
    return error;
  };

  it("the session says it is over only after the call: the error passes as it is, its label kept", async () => {
    const session = live().client.startSession();
    try {
      session.startTransaction();
      expect(session.inTransaction()).toBe(true);
      const failed = transient();
      // a command whose failure ended the transaction: a server cannot be made to reply so on demand
      vi.spyOn(Collection.prototype, "insertOne").mockImplementation(async () => {
        await session.abortTransaction();
        throw failed;
      });

      const failure: unknown = await probe()
        .insertOne({ _id: "tx" }, { session })
        .catch((error: unknown) => error);

      expect(session.inTransaction()).toBe(false);
      expect(failure).toBe(failed);
      expect(failure).not.toBeInstanceOf(StoreOutcomeUnknownError);
      expect((failure as MongoServerError).hasErrorLabel("TransientTransactionError")).toBe(true);
    } finally {
      await session.endSession();
    }
  });

  it("control: the same failure outside a transaction is unknown", async () => {
    const failed = transient();
    vi.spyOn(Collection.prototype, "insertOne").mockRejectedValue(failed);

    const failure: unknown = await probe()
      .insertOne({ _id: "no-tx" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StoreOutcomeUnknownError);
    expect(failure).toMatchObject({ cause: failed });
  });
});
