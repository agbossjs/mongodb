/**
 * agbossjs/agboss#1236: the refusal of a driver without the bounded stop's internals names the
 * installed driver's version, and `unknown` when its package.json cannot be read or holds no
 * string version: the refusal itself never fails on it.
 */
import { MongoClient } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("node:module");
  vi.resetModules();
});

/** `assertDriverInternals` loaded with `createRequire` answering `required` (or throwing it). */
async function refusalWith(required: () => unknown): Promise<unknown> {
  vi.resetModules();
  // the only use of node:module among the modules it loads (src/connection/close-bounded.ts)
  vi.doMock("node:module", () => ({ createRequire: () => required }));
  const { assertDriverInternals } = await import("../../src/connection/close-bounded.js");
  // an unconnected client has no topology: refused
  const client = new MongoClient("mongodb://127.0.0.1:1/?directConnection=true");
  try {
    assertDriverInternals(client);
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("the driver's version in the refusal", () => {
  it("as its package.json says", async () => {
    expect(await refusalWith(() => ({ version: "7.9.0" }))).toMatchObject({
      driverVersion: "7.9.0",
    });
  });

  it("unknown when its version is no string", async () => {
    expect(await refusalWith(() => ({ version: 7 }))).toMatchObject({ driverVersion: "unknown" });
  });

  it("unknown when its package.json cannot be read", async () => {
    const refusal = await refusalWith(() => {
      throw new Error("Cannot find module 'mongodb/package.json'");
    });

    expect(refusal).toMatchObject({
      code: "mongodb.driver-internals-missing",
      driverVersion: "unknown",
    });
  });
});
