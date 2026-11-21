/**
 * agbossjs/mongodb#103: what the leases shard's re-run alone showed (survivors that the shard's own
 * bound read as Timeouts). The execution id's claim reads a duplicate as "claimed" and nothing else;
 * the take that follows a cancel's seed is read after it, not before; the lease store names itself,
 * every one of its eight writes names its operation, and the cancel mark is read alone.
 */
import { StoreClock, StoreTimeSource, type ExecutionTree } from "@agboss/core";
import { StoreOutcomeSource, StoreOutcomeUnknownError } from "@agboss/core/stores";
import { seconds } from "@agboss/core/units";
import { MongoNetworkError } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Collections, MongoConnection, MongoExecutionLeaseRepository } from "../../src/index.js";
import { HandClock } from "../contracts/lease-races.js";
import { instanceConnection } from "../contracts/mongodb-store.js";
import { TestApplicationContext } from "../support/application-context.js";
import { commandsOf, nameOf } from "../support/command-log.js";
import { emptyAll, testDatabase } from "../support/database.js";

vi.mock("mongodb", async (importOriginal) => {
  const { reportingCommands } = await import("../support/command-log.js");
  return reportingCommands(await importOriginal());
});

const database = testDatabase();
const LEASE = seconds(30);
const TENANT = "default";
const BROKEN = new Error("unreadable");

beforeEach(() => emptyAll(database.url()));
afterEach(() => {
  vi.restoreAllMocks();
});

async function leasesOf(instanceId: string) {
  const connection = await instanceConnection(database, instanceId);
  const leases = new MongoExecutionLeaseRepository(
    connection,
    new StoreClock(StoreTimeSource.Test, new HandClock()),
    new TestApplicationContext({}, instanceId),
  );
  return { connection, leases };
}

/** `member`, when a function, bound to `target`, as the driver's methods need. */
const bound = (member: unknown, target: object): unknown =>
  typeof member === "function" ? (Function.prototype.bind.call(member, target) as unknown) : member;

const unreadable = <TValue extends object>(value: TValue, field: string): TValue =>
  Object.create(value, {
    [field]: {
      get(): string {
        throw BROKEN;
      },
    },
  }) as TValue;

/**
 * From now on, the lease collection's `findOneAndUpdate` of `connection` is `answer(n, real)`: `n` the number of the
 * call from 1, `real` the call as the driver would make it.
 */
function overFindOneAndUpdate(
  connection: Awaited<ReturnType<typeof leasesOf>>["connection"],
  answer: (n: number, real: () => Promise<unknown>) => Promise<unknown>,
): void {
  const raw = connection.client.db(connection.db.databaseName);
  const calls = { n: 0 };
  vi.spyOn(connection.db, "collection").mockImplementation((name, options) => {
    const collection = raw.collection(name, options);
    if (name !== Collections.ExecutionLeases) return collection;
    return new Proxy(collection, {
      get(target, property) {
        const member: unknown = Reflect.get(target, property, target);
        if (property !== "findOneAndUpdate" || typeof member !== "function")
          return bound(member, target);
        return (...args: unknown[]) => {
          calls.n += 1;
          return answer(calls.n, () => Promise.resolve(Reflect.apply(member, target, args)));
        };
      },
    });
  });
}

describe("the store", () => {
  it("is the MongoDB backend", () => {
    expect(MongoExecutionLeaseRepository.store).toEqual({ backend: "mongodb" });
  });
});

describe("a write whose own arguments cannot be read names its operation", () => {
  it("requestCancel", async () => {
    const { leases } = await leasesOf("instance-1");
    const tree: ExecutionTree = { tenantId: TENANT, rootExecutionId: "root-1" };

    const error = await leases.requestCancel(unreadable(tree, "tenantId")).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(StoreOutcomeUnknownError);
    expect(error).toMatchObject({ operation: "requestCancel", cause: BROKEN });
  });

  it("claimExecutionId", async () => {
    const { leases } = await leasesOf("instance-1");

    const error = await leases
      .claimExecutionId(unreadable({ executionId: "e", tenantId: TENANT }, "tenantId"))
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );

    expect(error).toBeInstanceOf(StoreOutcomeUnknownError);
    expect(error).toMatchObject({ operation: "claimExecutionId", cause: BROKEN });
  });
});

describe("claimExecutionId", () => {
  it("the first claim of an id is true, a second is false, another id is true", async () => {
    const { leases } = await leasesOf("instance-1");

    expect(await leases.claimExecutionId({ executionId: "e1", tenantId: TENANT })).toBe(true);
    expect(await leases.claimExecutionId({ executionId: "e1", tenantId: TENANT })).toBe(false);
    expect(await leases.claimExecutionId({ executionId: "e2", tenantId: TENANT })).toBe(true);
  });

  it("an insert that fails any other way is an error of unknown outcome, never `false`: the id is not said to be taken", async () => {
    const { connection, leases } = await leasesOf("instance-1");
    const lost = new MongoNetworkError("the reply was lost");
    const raw = connection.client.db(connection.db.databaseName);
    vi.spyOn(connection.db, "collection").mockImplementation((name, options) => {
      const collection = raw.collection(name, options);
      return new Proxy(collection, {
        get(target, property) {
          if (property === "insertOne") return () => Promise.reject(lost);
          const member: unknown = Reflect.get(target, property, target);
          return bound(member, target);
        },
      });
    });

    const claimed = await leases.claimExecutionId({ executionId: "e1", tenantId: TENANT }).then(
      (answer) => answer,
      (failure: unknown) => failure,
    );

    expect(claimed).toBeInstanceOf(StoreOutcomeUnknownError);
    expect(claimed).toMatchObject({ source: StoreOutcomeSource.Transport, cause: lost });
  });
});

describe("a take that finds the seed of a cancel made since its first look (#1117)", () => {
  it("answers the lease as the take left it: token 1, this instance its holder", async () => {
    const { connection, leases } = await leasesOf("instance-1");
    const { leases: other } = await leasesOf("instance-2");
    const tree: ExecutionTree = { tenantId: TENANT, rootExecutionId: "root-seeded" };
    const raw = connection.client.db(connection.db.databaseName);
    const looks = { done: 0 };
    vi.spyOn(connection.db, "collection").mockImplementation((name, options) => {
      const collection = raw.collection(name, options);
      if (name !== Collections.ExecutionLeases) return collection;
      return new Proxy(collection, {
        get(target, property) {
          const member: unknown = Reflect.get(target, property, target);
          if (property !== "findOneAndUpdate" || typeof member !== "function")
            return bound(member, target);
          return async (...args: unknown[]) => {
            const found: unknown = await Reflect.apply(member, target, args);
            looks.done += 1;
            // the cancel seeds the tree's document between the first look and the insert
            if (looks.done === 1) await other.requestCancel(tree);
            return found;
          };
        },
      });
    });

    const lease = await leases.acquire(TENANT, tree.rootExecutionId, LEASE);

    // two looks answered (the first take, the last one); the insert between them failed on the seed
    expect(looks.done).toBe(2);
    expect(lease).toMatchObject({
      tenantId: TENANT,
      rootExecutionId: tree.rootExecutionId,
      holderInstanceId: "instance-1",
      token: 1,
    });
  });
});

describe("isCancelRequested reads the mark alone", () => {
  it("one find of the tree's lease document, projecting `cancelRequestedAt`", async () => {
    const { connection, leases } = await leasesOf("instance-1");
    const sent = commandsOf(connection);

    await leases.isCancelRequested({ tenantId: TENANT, rootExecutionId: "root-1" });

    const finds = sent.filter((one) => nameOf(one) === `find ${Collections.ExecutionLeases}`);
    expect(finds).toHaveLength(1);
    expect(finds[0]?.command.projection).toEqual({ cancelRequestedAt: 1 });
  });
});

describe("acquire, when the insert of the tree's first lease answers otherwise than the server does", () => {
  it("an answer of none is no lease: acquire gives undefined, it does not read a lease from nothing", async () => {
    const { connection, leases } = await leasesOf("instance-1");
    overFindOneAndUpdate(connection, (n, real) => (n === 1 ? real() : Promise.resolve(null)));

    expect(await leases.acquire(TENANT, "root-none", LEASE)).toBeUndefined();
  });

  it("an error that is no duplicate key is the error, not a retake: nothing else is asked of the server", async () => {
    const { connection, leases } = await leasesOf("instance-1");
    const lost = new MongoNetworkError("the reply was lost");
    const asked = { n: 0 };
    overFindOneAndUpdate(connection, (n, real) => {
      asked.n = n;
      return n === 1 ? real() : Promise.reject(lost);
    });

    const error = await leases.acquire(TENANT, "root-lost", LEASE).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(StoreOutcomeUnknownError);
    expect(error).toMatchObject({ cause: lost });
    expect(asked.n).toBe(2);
  });
});

describe("ping", () => {
  it("answers on a server, and rejects on a deployment that does not answer", async () => {
    const { leases } = await leasesOf("instance-1");
    await expect(leases.ping()).resolves.toBeUndefined();

    const lost = new MongoConnection({
      url: "mongodb://127.0.0.1:1/?replicaSet=rs0&serverSelectionTimeoutMS=200",
    });
    try {
      const store = new MongoExecutionLeaseRepository(
        lost,
        new StoreClock(StoreTimeSource.Test, new HandClock()),
        new TestApplicationContext({}, "instance-1"),
      );
      await expect(store.ping()).rejects.toThrow();
    } finally {
      await lost.onDestroy();
    }
  });
});
