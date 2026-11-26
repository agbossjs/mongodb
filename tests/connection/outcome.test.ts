/**
 * agbossjs/mongodb#76, agbossjs/agboss#1017: the classifier of a write's error is a whitelist — only
 * the server's error reply that proves nothing was applied is known; every other error after the
 * send is `StoreError.OutcomeUnknown` (source `Transport`, the error its cause).
 */
import { StoreOutcomeSource, StoreError } from "@agboss/core/stores";
import {
  MongoNetworkError,
  MongoNetworkTimeoutError,
  MongoNotConnectedError,
  MongoServerError,
  MongoWriteConcernError,
} from "mongodb";
import { describe, expect, it } from "vitest";
import { commitErrorOf, writeErrorOf } from "../../src/connection/outcome.js";

const server = (code: number | undefined, labels: readonly string[] = []): MongoServerError => {
  const error = new MongoServerError({ message: "the server said no", code });
  for (const label of labels) error.addErrorLabel(label);
  return error;
};

const KNOWN: readonly (readonly [string, Error])[] = [
  ["a duplicate key (11000)", server(11000)],
  ["a duplicate key on an index (11001)", server(11001)],
  ["a duplicate key on update (12582)", server(12582)],
  ["a document validation failure (121)", server(121)],
  ["a write conflict (112) of an aborted transaction", server(112)],
  ["a bad value (2)", server(2)],
  ["a failed parse (9)", server(9)],
  ["a conflicting update operator (40)", server(40)],
  ["a type mismatch (14)", server(14)],
];

const UNKNOWN: readonly (readonly [string, unknown])[] = [
  ["a network error", new MongoNetworkError("connection reset")],
  ["a network timeout", new MongoNetworkTimeoutError("socket timeout")],
  [
    "a write concern error (applied, not acknowledged)",
    new MongoWriteConcernError({ ok: 1, writeConcernError: { code: 91, errmsg: "shutting down" } }),
  ],
  [
    "an unsatisfiable write concern (100)",
    new MongoWriteConcernError({ ok: 1, writeConcernError: { code: 100, errmsg: "no" } }),
  ],
  ["NotWritablePrimary (10107) after the send", server(10107, ["RetryableWriteError"])],
  ["PrimarySteppedDown (189)", server(189, ["RetryableWriteError"])],
  ["ExceededTimeLimit (262)", server(262)],
  ["an unrecognised code (999999)", server(999_999)],
  ["a server error with no code", server(undefined)],
  ["a client error of the driver", new MongoNotConnectedError("not connected")],
  [
    "NoSuchTransaction (251): under retryWrites the retry of an applied write can be answered with it",
    server(251),
  ],
  ["Unauthorized (13): the retry of an applied write after a revoked role", server(13)],
  ["an immutable field (66) of a write that may be a multi-document one", server(66)],
  ["a plain Error", new Error("boom")],
  ["a TypeError", new TypeError("x")],
  ["a thrown string", "boom"],
];

describe("agbossjs/mongodb#76: the write classifier is a whitelist", () => {
  it.each(KNOWN)("%s is known: rethrown as it is", (_name, error) => {
    expect(writeErrorOf("op", error)).toBe(error);
  });

  it.each(UNKNOWN)("%s is unknown", (_name, error) => {
    const read = writeErrorOf("coll.updateOne", error);

    expect(read).toBeInstanceOf(StoreError.OutcomeUnknown);
    expect(read).toMatchObject({
      code: "store.outcome-unknown",
      operation: "coll.updateOne",
      source: StoreOutcomeSource.Transport,
      cause: error,
    });
  });

  it("an error that is already unknown passes through", () => {
    const unknown = writeErrorOf("op", new Error("x"));

    expect(writeErrorOf("other", unknown)).toBe(unknown);
  });
});

describe("agbossjs/mongodb#76: a write of many documents outside a transaction is not atomic", () => {
  it.each([
    ["a duplicate key (11000)", 11000],
    ["a duplicate key (11001)", 11001],
    ["a duplicate key on update (12582)", 12582],
    ["a document validation failure (121)", 121],
    ["a write conflict (112)", 112],
  ])("%s: the documents before the failing one stay written — unknown", (_name, code) => {
    const error = server(code);

    expect(writeErrorOf("coll.updateMany", error, true)).toBeInstanceOf(StoreError.OutcomeUnknown);
    expect(writeErrorOf("coll.updateMany", error, true)).toMatchObject({ cause: error });
  });

  it.each([2, 9, 14, 40])(
    "a refusal of the command's form (%i) is known before anything ran",
    (code) => {
      const error = server(code);

      expect(writeErrorOf("coll.deleteMany", error, true)).toBe(error);
    },
  );
});

describe("agbossjs/mongodb#76: a commit is never known (the driver retries it itself: the error seen may be the retry's)", () => {
  it.each([
    [
      "NoSuchTransaction (251): the retry of a transaction the first attempt committed",
      server(251),
    ],
    ["NoSuchTransaction labelled transient", server(251, ["TransientTransactionError"])],
    ["a write conflict (112)", server(112, ["TransientTransactionError"])],
    ["a duplicate key (11000)", server(11000)],
    ["UnknownTransactionCommitResult", server(91, ["UnknownTransactionCommitResult"])],
    ["a transport error", new MongoNetworkError("reset")],
    [
      "a write concern error",
      new MongoWriteConcernError({ ok: 1, writeConcernError: { code: 91, errmsg: "x" } }),
    ],
    ["an unrecognised code", server(999_999)],
    ["no code", server(undefined)],
    ["a plain Error", new Error("boom")],
  ] as const)("%s is unknown", (_name, error) => {
    const read = commitErrorOf(error);

    expect(read).toBeInstanceOf(StoreError.OutcomeUnknown);
    expect(read).toMatchObject({ operation: "commitTransaction", cause: error });
  });

  it("an error that is already unknown passes through", () => {
    const unknown = commitErrorOf(new Error("x"));

    expect(commitErrorOf(unknown)).toBe(unknown);
  });
});
