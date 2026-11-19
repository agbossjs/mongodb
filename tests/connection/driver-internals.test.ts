/**
 * agbossjs/agboss#1236 — the bounded stop (#954) reaches the `mongodb` driver's internals by name
 * (`client.topology`, its `close`, `s.servers`, each pool's `checkedOut`). The installed driver is
 * the pinned one and has them, in the shape the stop expects: a driver bump that renames one breaks
 * this file in CI, and a connection built on such a driver does not start (a typed error), never a
 * stop that silently leaves the sockets open.
 */
import { readFileSync } from "node:fs";
import { SchemaSetup } from "@agboss/core/stores";
import { MongoClient } from "mongodb";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertDriverInternals,
  missingDriverInternal,
} from "../../src/connection/close-bounded.js";
import { MongoDriverInternalsError, MongoConnection } from "../../src/index.js";
import { freshDatabaseName, REPLICA_SET_URL } from "../support/server.js";

/** A file of the package or of the installed driver, parsed. */
const jsonOf = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const versionOf = (manifest: unknown): unknown =>
  typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "version") : undefined;
const dependencyOf = (manifest: unknown, name: string): unknown => {
  const dependencies: unknown =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(manifest, "dependencies")
      : undefined;
  return typeof dependencies === "object" && dependencies !== null
    ? Reflect.get(dependencies, name)
    : undefined;
};

const opened: MongoClient[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((client) => client.close()));
});

async function connected(): Promise<MongoClient> {
  const client = new MongoClient(REPLICA_SET_URL, { serverSelectionTimeoutMS: 10_000 });
  opened.push(client);
  await client.connect();
  return client;
}

describe("#1236: the driver is held to the version the stop was tested with", () => {
  it("package.json names one exact driver version, and it is the installed one", () => {
    const pinned = dependencyOf(jsonOf("../../package.json"), "mongodb");
    const installed = versionOf(jsonOf("../../node_modules/mongodb/package.json"));

    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(installed).toBe(pinned);
  });
});

describe("#1236: the installed driver has the internals the bounded stop reaches", () => {
  it("a connected client has topology.close, s.servers (a Map) and each pool's checkedOut (a Set)", async () => {
    const client = await connected();

    const topology: unknown = Reflect.get(client, "topology");
    expect(typeof topology).toBe("object");
    expect(typeof Reflect.get(topology as object, "close")).toBe("function");
    const state: unknown = Reflect.get(topology as object, "s");
    const servers: unknown = Reflect.get(state as object, "servers");
    expect(servers).toBeInstanceOf(Map);
    const pools = [...(servers as Map<unknown, unknown>).values()].map((server): unknown =>
      Reflect.get(Reflect.get(server as object, "pool") as object, "checkedOut"),
    );
    expect(pools.length).toBeGreaterThan(0);
    for (const checkedOut of pools) expect(checkedOut).toBeInstanceOf(Set);
    expect(missingDriverInternal(client)).toBeUndefined();
    expect(() => {
      assertDriverInternals(client);
    }).not.toThrow();
  });
});

/** The own property `name` of `target` removed from view (as a driver's rename does) while `run` runs. */
function withoutMember(target: object, name: string, run: () => void): void {
  const own = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { value: undefined, configurable: true, writable: true });
  try {
    run();
  } finally {
    if (own === undefined) Reflect.deleteProperty(target, name);
    else Object.defineProperty(target, name, own);
  }
}

describe("#1236: a driver without them fails loudly, naming its version and the internal", () => {
  it("an unconnected client has no topology: the first thing missing is named", () => {
    const client = new MongoClient("mongodb://127.0.0.1:1/?directConnection=true");

    expect(missingDriverInternal(client)).toBe("client.topology (an object)");
  });

  it("each internal renamed: named, and thrown as MongoDriverInternalsError with the version", async () => {
    const client = await connected();
    const topology = Reflect.get(client, "topology") as object;
    const state = Reflect.get(topology, "s") as object;
    const server = [...(Reflect.get(state, "servers") as Map<unknown, object>).values()][0] ?? {};
    const pool = Reflect.get(server, "pool") as object;
    const version = versionOf(jsonOf("../../node_modules/mongodb/package.json"));
    const cases: [object, string, string][] = [
      [client, "topology", "client.topology (an object)"],
      [topology, "close", "client.topology.close (a function)"],
      [state, "servers", "client.topology.s.servers (a Map)"],
      [pool, "checkedOut", "client.topology.s.servers[].pool.checkedOut (a Set)"],
    ];

    for (const [target, name, expected] of cases) {
      withoutMember(target, name, () => {
        expect(missingDriverInternal(client)).toBe(expected);
        const thrown = catching(() => {
          assertDriverInternals(client);
        });
        expect(thrown).toBeInstanceOf(MongoDriverInternalsError);
        expect(thrown).toMatchObject({
          code: "mongodb.driver-internals-missing",
          driverVersion: version,
          missing: expected,
        });
        expect((thrown as Error).message).toContain(`driver ${String(version)}`);
        expect((thrown as Error).message).toContain(expected);
      });
    }
    expect(missingDriverInternal(client)).toBeUndefined();
  });

  it("a connection on such a driver does not start: onInit rejects with the typed error", async () => {
    const connection = new MongoConnection({
      url: REPLICA_SET_URL,
      database: freshDatabaseName(),
      schemaSetup: SchemaSetup.MigrateOnStart,
    });
    // the driver needs its `topology` to connect: hidden once it did, as a driver that names it otherwise
    const connect = connection.client.connect.bind(connection.client);
    Object.defineProperty(connection.client, "connect", {
      value: async (): Promise<MongoClient> => {
        const client = await connect();
        Object.defineProperty(client, "topology", { value: undefined, configurable: true });
        return client;
      },
    });

    await expect(connection.onInit()).rejects.toBeInstanceOf(MongoDriverInternalsError);
    await expect(connection.onInit()).rejects.toMatchObject({
      missing: "client.topology (an object)",
    });
  });
});

/** What `run` throws, `undefined` when it does not. */
function catching(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}
