/**
 * agbossjs/mongodb#99: the client the connection builds is checked once more, after it is built:
 * a driver that did not carry the enforced options (a release that drops or renames one) is
 * `MongoDurabilityError` at construction, never a connection that writes at `w=1`.
 */
import { describe, expect, it, vi } from "vitest";
import { MongoConnection, MongoDurabilityError } from "../../src/index.js";

vi.mock("mongodb", async (importOriginal) => {
  const driver = await importOriginal<typeof import("mongodb")>();
  /** A client that carries the weaker concerns whatever it is told: the driver that dropped them. */
  class WeakClient extends driver.MongoClient {
    constructor(url: string, options?: import("mongodb").MongoClientOptions) {
      super(
        url,
        options?.writeConcern === undefined
          ? options
          : { ...options, writeConcern: { w: 1 }, readConcern: { level: "local" } },
      );
    }
  }
  return { ...driver, MongoClient: WeakClient };
});

describe("agbossjs/mongodb#99: a client that lost an enforced option is refused", () => {
  it("names every concern the client does not carry", () => {
    const build = (): unknown =>
      new MongoConnection({ url: "mongodb://db1:27017/?replicaSet=rs0" });

    expect(build).toThrow(MongoDurabilityError);
    try {
      build();
    } catch (error) {
      expect(error).toMatchObject({
        problems: [
          "the client's write concern is not w=majority",
          "the client's write concern does not wait for the journal",
          "the client's read concern is not majority",
        ],
      });
    }
  });
});
