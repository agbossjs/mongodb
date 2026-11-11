import { describe, expect, it } from "vitest";
import { MongoDeploymentError, MongoTopology } from "../../src/index.js";
import { supportedTopologyOf, topologyOf } from "../../src/connection/deployment.js";

/** Fakes of the server's `hello` replies (the fields the check reads, and some it ignores). */
const REPLICA_SET_PRIMARY = {
  isWritablePrimary: true,
  setName: "rs0",
  hosts: ["localhost:27017"],
  maxWireVersion: 21,
  ok: 1,
};
const MONGOS = { isWritablePrimary: true, msg: "isdbgrid", maxWireVersion: 21, ok: 1 };
const STANDALONE = { isWritablePrimary: true, maxWireVersion: 21, ok: 1 };

describe("topologyOf: the deployment a hello reply describes", () => {
  it("a reply with setName is a replica set member", () => {
    expect(topologyOf(REPLICA_SET_PRIMARY)).toBe(MongoTopology.ReplicaSet);
  });

  it("a secondary of a replica set is a replica set member too", () => {
    expect(topologyOf({ ...REPLICA_SET_PRIMARY, isWritablePrimary: false, secondary: true })).toBe(
      MongoTopology.ReplicaSet,
    );
  });

  it("msg: isdbgrid is a mongos router of a sharded cluster", () => {
    expect(topologyOf(MONGOS)).toBe(MongoTopology.Sharded);
  });

  it("a reply with neither is a standalone mongod", () => {
    expect(topologyOf(STANDALONE)).toBe(MongoTopology.Standalone);
  });

  it("an empty setName is not a replica set", () => {
    expect(topologyOf({ ...STANDALONE, setName: "" })).toBe(MongoTopology.Standalone);
  });

  it("another msg is not a mongos", () => {
    expect(topologyOf({ ...STANDALONE, msg: "hello" })).toBe(MongoTopology.Standalone);
  });

  it.each([undefined, null, "rs0", 1, { setName: 7 }, { msg: false }])(
    "a malformed reply %o is treated as a standalone: never assumed safe",
    (reply) => {
      expect(topologyOf(reply)).toBe(MongoTopology.Standalone);
    },
  );
});

describe("supportedTopologyOf: the start check", () => {
  it("a replica set passes", () => {
    expect(supportedTopologyOf(REPLICA_SET_PRIMARY)).toBe(MongoTopology.ReplicaSet);
  });

  it("a sharded cluster passes", () => {
    expect(supportedTopologyOf(MONGOS)).toBe(MongoTopology.Sharded);
  });

  it("a standalone fails with MongoDeploymentError, saying how to start a replica set", () => {
    expect(() => supportedTopologyOf(STANDALONE)).toThrow(MongoDeploymentError);
    expect(() => supportedTopologyOf(STANDALONE)).toThrow(
      /standalone mongod: the stores need a replica set .* --replSet and run rs\.initiate\(\)/,
    );
  });

  it("the error has its stable code and name", () => {
    const error = new MongoDeploymentError();

    expect(error.code).toBe("mongodb.deployment-unsupported");
    expect(MongoDeploymentError.code).toBe("mongodb.deployment-unsupported");
    expect(error.name).toBe("MongoDeploymentError");
  });
});
