/** agbossjs/agboss#1213: the ledger's `ping` is the connection's. */
import { describe, expect, it, vi } from "vitest";
import { MongoCostLedgerRepository } from "../../src/index.js";
import { connectionTo } from "../support/stores.js";

describe("MongoCostLedgerRepository: ping", () => {
  it("is one ping of the connection", async () => {
    const connection = connectionTo("mongodb://localhost:1/unused");
    const ping = vi.spyOn(connection, "ping").mockResolvedValue();

    await new MongoCostLedgerRepository(connection).ping();

    expect(ping).toHaveBeenCalledOnce();
  });
});
