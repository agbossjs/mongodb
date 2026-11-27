/**
 * The lookup of an outbound call's or an effect's document after a rotation of the idempotency secret
 * (agbossjs/agboss#1317d), as the client sends it (a fake collection, no server).
 */
import { effectKeyIdentityOf } from "@agboss/core/stores";
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { describe, expect, it } from "vitest";
import { previousIdOf } from "../../src/stores/key-entry.js";
import { idOf } from "../../src/stores/keys.js";
import { foundOf } from "../../src/stores/outbound-calls/outbound-call-lookup.js";

const SESSION = { id: "session" } as never;

const keyOf = (extra: object = {}) =>
  effectKeyForTesting({
    scopeKey: "default:root-1",
    tenantId: "default",
    leaseExecutionId: "root-1",
    token: 1,
    idempotencyKey: "root-1:charge:1",
    name: "charge",
    ...extra,
  });
const rotated = () =>
  keyOf({ businessKey: "digest-new", previousBusinessKey: "digest-old", withoutFingerprint: true });

describe("previousIdOf", () => {
  it("is the identity the previous secret's digest of the business key gives, never the key's own", () => {
    const key = rotated();
    const previous = keyOf({
      businessKey: "digest-old",
      previousBusinessKey: "digest-old",
      withoutFingerprint: true,
    });

    expect(previousIdOf(key)).toBe(idOf(effectKeyIdentityOf(previous)));
    expect(previousIdOf(key)).not.toBe(idOf(effectKeyIdentityOf(key)));
  });

  it("is none for a key with no business key or no previous digest", () => {
    expect(previousIdOf(keyOf())).toBeUndefined();
    expect(
      previousIdOf(keyOf({ businessKey: "digest", withoutFingerprint: true })),
    ).toBeUndefined();
    expect(
      previousIdOf(keyOf({ previousBusinessKey: "digest-old", withoutFingerprint: true })),
    ).toBeUndefined();
  });
});

describe("foundOf", () => {
  const calls = (answers: (object | null)[]) => {
    const log: unknown[][] = [];
    const collection = {
      findOne: (...args: unknown[]) => {
        log.push(args);
        return Promise.resolve(answers.shift() ?? null);
      },
    } as never;
    return { collection, log };
  };

  it("is the document of the key's own identity, and asks no more when it is there", async () => {
    const { collection, log } = calls([{ _id: "own" }]);
    const key = rotated();

    expect(await foundOf(collection, key, SESSION)).toStrictEqual({ _id: "own" });

    expect(log).toStrictEqual([[{ _id: idOf(effectKeyIdentityOf(key)) }, { session: SESSION }]]);
  });

  it("asks for the previous digest's document when the own one is not there, in the same session", async () => {
    const { collection, log } = calls([null, { _id: "old" }]);
    const key = rotated();

    expect(await foundOf(collection, key, SESSION)).toStrictEqual({ _id: "old" });

    expect(log[1]).toStrictEqual([{ _id: previousIdOf(key) }, { session: SESSION }]);
  });

  it("is none, after one question, for a key with no previous digest", async () => {
    const { collection, log } = calls([null]);

    expect(await foundOf(collection, keyOf(), SESSION)).toBeNull();

    expect(log).toHaveLength(1);
  });
});
