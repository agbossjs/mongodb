/** agbossjs/agboss#1213: the rate limits' `ping` is the connection's. */
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it, vi } from "vitest";
import { MongoRateLimitRepository } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { connectionTo } from "../support/stores.js";

describe("MongoRateLimitRepository: ping", () => {
  it("is one ping of the connection", async () => {
    const connection = connectionTo("mongodb://localhost:1/unused");
    const ping = vi.spyOn(connection, "ping").mockResolvedValue();
    const limits = new MongoRateLimitRepository(
      connection,
      new VirtualClock(),
      new TestApplicationContext(),
    );

    await limits.ping();

    expect(ping).toHaveBeenCalledOnce();
  });
});
