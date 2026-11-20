/**
 * agbossjs/mongodb#100: how the lease store reads a lease document, on documents given by hand —
 * the survivors of the leases shard that a cold CI run found and a local one counted as timeouts:
 * a document with no token is refused, and a takeover is named only when the previous holder and
 * the previous token are both there.
 */
import { seconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { leaseOf, StoredLease, TokenFields } from "../../src/stores/lease-documents.js";

const KEY = { tenantId: "default", rootExecutionId: "root-1" };
const EXPIRES = new Date("2026-01-05T09:00:30.000Z");
const LEASE = seconds(30);

/** A stored lease document of holder `h2`, at `token` 7, with what `previous` adds. */
const documentOf = (previous: Record<string, unknown> = {}) => ({
  token: 7,
  holderInstanceId: "h2",
  expiresAt: EXPIRES,
  released: false,
  ...previous,
});

describe("agbossjs/mongodb#100: a lease document has a token", () => {
  it.each([[{ token: 1 }], [{ leaseEpoch: 2 }], [{ token: 1, leaseEpoch: 2 }]])(
    "%o is read",
    (fields) => {
      expect(TokenFields.safeParse(fields).success).toBe(true);
    },
  );

  it("one with neither a token nor a 0.1.0 leaseEpoch is refused, with the reason", () => {
    const read = TokenFields.safeParse({});

    expect(read.success).toBe(false);
    expect(read.error?.issues[0]?.message).toBe(
      "a lease document has a token (or a 0.1.0 leaseEpoch)",
    );
  });

  it("a stored lease with no token is refused whatever else it holds", () => {
    const withoutToken = { holderInstanceId: "h2", expiresAt: EXPIRES, released: false };

    expect(StoredLease.safeParse(withoutToken).success).toBe(false);
    expect(() => leaseOf(withoutToken, LEASE, KEY)).toThrow("a lease document has a token");
  });
});

describe("agbossjs/mongodb#100: a lease is a takeover only when it names who it was taken from", () => {
  it("both the previous holder and the previous token: the takeover is named", () => {
    const lease = leaseOf(documentOf({ previousHolder: "h1", previousToken: 6 }), LEASE, KEY);

    expect(lease).toEqual({
      ...KEY,
      holderInstanceId: "h2",
      token: 7,
      expiresAt: EXPIRES,
      remaining: LEASE,
      takenOverFrom: { holderInstanceId: "h1", token: 6 },
    });
  });

  it.each([
    ["no previous holder at all", { previousToken: 6 }],
    ["a previous holder that is null", { previousHolder: null, previousToken: 6 }],
    ["no previous token at all", { previousHolder: "h1" }],
    ["a previous token that is null", { previousHolder: "h1", previousToken: null }],
    ["neither", {}],
    ["both null", { previousHolder: null, previousToken: null }],
  ])("%s: no takeover", (_name, previous) => {
    const lease = leaseOf(documentOf(previous), LEASE, KEY);

    expect(lease).toEqual({
      ...KEY,
      holderInstanceId: "h2",
      token: 7,
      expiresAt: EXPIRES,
      remaining: LEASE,
    });
    expect(lease).not.toHaveProperty("takenOverFrom");
  });

  it("a previous token of 0 is a token: the takeover is named", () => {
    const lease = leaseOf(documentOf({ previousHolder: "h1", previousToken: 0 }), LEASE, KEY);

    expect(lease.takenOverFrom).toEqual({ holderInstanceId: "h1", token: 0 });
  });
});
