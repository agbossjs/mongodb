/**
 * agbossjs/mongodb#76: a duplicate key on a write's retry proves the first attempt did nothing only
 * while the server holds that attempt's receipt (30 minutes, `localLogicalSessionTimeoutMinutes`).
 * A socket that hangs for longer must time out first, so the client's `socketTimeoutMS` is bounded
 * well below it, whatever the URL says (the default 0 and a URL's 0 are infinite).
 */
import { describe, expect, it } from "vitest";
import { REPLICA_SET_URL } from "../support/server.js";
import { connectionTo } from "../support/stores.js";

const RECEIPT_MS = 30 * 60_000;
const TRANSACTION_MS = 60_000;

describe("agbossjs/mongodb#76: the client's socket timeout is bounded", () => {
  it.each([
    ["the URL names none", REPLICA_SET_URL],
    ["the URL says 0 (infinite)", `${REPLICA_SET_URL}&socketTimeoutMS=0`],
    ["the URL says a day", `${REPLICA_SET_URL}&socketTimeoutMS=86400000`],
  ])("%s: it is above a transaction's lifetime and under half the receipt's", (_name, url) => {
    const timeout = connectionTo(url).client.options.socketTimeoutMS;

    expect(timeout).toBeGreaterThan(TRANSACTION_MS);
    expect(timeout).toBeLessThanOrEqual(RECEIPT_MS / 2);
  });
});
