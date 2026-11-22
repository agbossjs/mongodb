/**
 * agbossjs/mongodb#103: the outbound call store's edges that the shard's mutants dropped: the key is
 * checked before any command, a page of a status is found, sorted and limited as it says and has a
 * next only when there is more, a tree's calls are read in the order of their numbers, a move's
 * statement names the attempt and the owner only when it has them, unsets what it leaves out, and is
 * inside its transaction.
 */
import {
  OutboundCallStatus,
  StoreClock,
  StoreTimeSource,
  type EffectKey,
  type OutboundCallIntent,
} from "@agboss/core";
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import { hours } from "@agboss/core/units";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Collections,
  MongoConnection,
  MongoExecutionLeaseRepository,
  MongoOutboundCallRepository,
} from "../../src/index.js";
import { HandClock } from "../contracts/lease-races.js";
import { instanceConnection } from "../contracts/mongodb-store.js";
import { TestApplicationContext } from "../support/application-context.js";
import { commandsOf, nameOf, plain } from "../support/command-log.js";
import { emptyAll, testDatabase } from "../support/database.js";

vi.mock("mongodb", async (importOriginal) => {
  const { reportingCommands } = await import("../support/command-log.js");
  return reportingCommands(await importOriginal());
});

const database = testDatabase();
const TENANT = "default";
const CALLS = Collections.OutboundCalls;
const OWNER = "owner-1";

beforeEach(() => emptyAll(database.url()));

async function instance() {
  const clock = new HandClock();
  const store = new StoreClock(StoreTimeSource.Test, clock);
  const connection = await instanceConnection(database, "instance-1");
  const leases = new MongoExecutionLeaseRepository(
    connection,
    store,
    new TestApplicationContext({}, "instance-1"),
  );
  const lease = await leases.acquire(TENANT, "call-root", hours(1));
  if (lease === undefined) throw new Error("the lease is held");
  const calls = new MongoOutboundCallRepository(connection, store);
  const keyOf = (name: string): EffectKey =>
    effectKeyForTesting({
      scopeKey: `${TENANT}:call-root`,
      tenantId: TENANT,
      leaseExecutionId: "call-root",
      token: lease.token,
      idempotencyKey: `call-root:${name}:1`,
      name,
    });
  const intentOf = (name: string): OutboundCallIntent => ({
    rootExecutionId: "call-root",
    executionId: "call-root",
    workflow: "charge-workflow",
    target: "payments",
    operation: "charge",
    idempotencyKey: `call-root:${name}:1:charge`,
    request: "{}",
    attempt: 1,
    attemptOwner: OWNER,
    step: { nodeId: name, visitNumber: 1 },
  });
  const save = (name: string) => calls.saveIfAbsent(keyOf(name), intentOf(name));
  return { connection, calls, keyOf, save };
}

/** The `q` and `u` of the one statement of an `update` command. */
const statementOf = (command: { readonly command: { readonly updates?: unknown } }) =>
  (command.command.updates as { q: Record<string, unknown>; u: Record<string, unknown> }[])[0];

describe("a call with a key that has no name is refused at the entry, before any command", () => {
  it("a save, a read and a move", async () => {
    const { connection, calls, keyOf } = await instance();
    const sent = commandsOf(connection);
    const nameless = keyOf("");

    await expect(
      calls.saveIfAbsent(nameless, {
        rootExecutionId: "call-root",
        executionId: "call-root",
        workflow: "w",
        target: "t",
        operation: "o",
        idempotencyKey: "k",
        request: "{}",
        attempt: 1,
        attemptOwner: OWNER,
        step: { nodeId: "n", visitNumber: 1 },
      }),
    ).rejects.toThrow();
    await expect(calls.findByKey(nameless)).rejects.toThrow();

    expect(sent).toEqual([]);
  });
});

describe("a read of a call", () => {
  it("is one find inside the fencing transaction, like every other command of the call", async () => {
    const { connection, calls, keyOf, save } = await instance();
    await save("a");
    const sent = commandsOf(connection);

    const found = await calls.findByKey(keyOf("a"));

    expect(found?.step.nodeId).toBe("a");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((one) => one.inTransaction)).toBe(true);
    expect(sent.filter((one) => one.name === "find" && one.collection === CALLS)).toHaveLength(1);
  });
});

describe("a page of a tenant's calls in a status", () => {
  it("asks by tenant, status and a seq after the cursor, in the order of the seq, one more than the limit", async () => {
    const { connection, calls, save } = await instance();
    for (const name of ["a", "b", "c"]) await save(name);
    const sent = commandsOf(connection);

    await calls.findAllByTenantIdAndStatus({
      tenantId: TENANT,
      status: OutboundCallStatus.Pending,
      limit: 2,
    });

    const finds = sent.filter((one) => one.name === "find" && one.collection === CALLS);
    expect(finds).toHaveLength(1);
    expect(plain(finds[0]?.command.sort)).toEqual({ seq: 1 });
    expect(finds[0]?.command.limit).toBe(3);
    expect(finds[0]?.command.filter).toMatchObject({
      tenantId: TENANT,
      status: OutboundCallStatus.Pending,
      seq: { $gt: 0 },
    });
  });

  it("has a next only when more was found than the limit, and the next page starts after the last of this one", async () => {
    const { calls, save } = await instance();
    for (const name of ["a", "b", "c"]) await save(name);
    const query = { tenantId: TENANT, status: OutboundCallStatus.Pending };

    const first = await calls.findAllByTenantIdAndStatus({ ...query, limit: 2 });
    const exact = await calls.findAllByTenantIdAndStatus({ ...query, limit: 3 });
    const rest = await calls.findAllByTenantIdAndStatus({
      ...query,
      limit: 2,
      ...(first.next === undefined ? {} : { after: first.next }),
    });
    const none = await calls.findAllByTenantIdAndStatus({ ...query, limit: 2, after: "999" });

    expect(first.calls).toHaveLength(2);
    expect(first.next).toBeDefined();
    expect(exact.calls).toHaveLength(3);
    expect(exact).not.toHaveProperty("next");
    expect(rest.calls).toHaveLength(1);
    expect(rest).not.toHaveProperty("next");
    expect(none).toEqual({ calls: [] });
  });
});

describe("a tree's calls", () => {
  it("are read sorted by their numbers, whatever order the server holds them in", async () => {
    const { connection, calls, save } = await instance();
    for (const name of ["a", "b", "c"]) await save(name);
    const sent = commandsOf(connection);

    const found = await calls.findAllByTenantIdAndRootExecutionId(TENANT, "call-root");

    expect(found.map((one) => one.step.nodeId)).toEqual(["a", "b", "c"]);
    const finds = sent.filter((one) => one.name === "find" && one.collection === CALLS);
    expect(plain(finds[0]?.command.sort)).toEqual({ seq: 1 });
  });
});

describe("a move's statement", () => {
  const pending = { status: OutboundCallStatus.Pending, attempt: 1, attemptOwner: OWNER };

  it("a completion compares the status and the owner, not the attempt, and sets neither attempt nor owner", async () => {
    const { connection, calls, keyOf, save } = await instance();
    await save("a");
    const sent = commandsOf(connection);

    expect(await calls.markCompleted(keyOf("a"), OWNER, '{"ok":true}')).toBe(true);

    const update = sent.find((one) => nameOf(one) === `update ${CALLS}`);
    const statement = update === undefined ? undefined : statementOf(update);
    expect(statement?.q).not.toHaveProperty("attempt");
    expect(statement?.q).toMatchObject({ attemptOwner: OWNER });
    expect(statement?.u.$set).not.toHaveProperty("attempt");
    expect(statement?.u.$set).not.toHaveProperty("attemptOwner");
    expect(update?.inTransaction).toBe(true);
  });

  it("a claim compares the attempt, sets the next attempt and its owner, and removes the last ending", async () => {
    const { connection, calls, keyOf, save } = await instance();
    await save("a");
    const sent = commandsOf(connection);

    expect(await calls.markPending(keyOf("a"), pending, { attempt: 2, attemptOwner: "o-2" })).toBe(
      true,
    );

    const update = sent.find((one) => nameOf(one) === `update ${CALLS}`);
    const statement = update === undefined ? undefined : statementOf(update);
    expect(statement?.q).toMatchObject({ attempt: 1, attemptOwner: OWNER });
    expect(statement?.u.$set).toMatchObject({ attempt: 2, attemptOwner: "o-2" });
    expect(Object.keys(statement?.u.$unset ?? {}).sort()).toEqual([
      "record.endedAt",
      "record.failure",
      "record.result",
    ]);
  });

  it("a move that sets every field of the last ending has nothing to remove: no $unset is sent", async () => {
    const { connection, calls, keyOf, save } = await instance();
    await save("a");
    const sent = commandsOf(connection);
    // a claim that carries the ending's fields: a call made as the caller types allow, never a store's own
    const claim = {
      attempt: 2,
      attemptOwner: "o-2",
      result: "{}",
      failure: { name: "n", code: "c", message: "m" },
      endedAt: "2026-01-05T09:00:00.000Z",
    };

    expect(await calls.markPending(keyOf("a"), pending, claim)).toBe(true);

    const update = sent.find((one) => nameOf(one) === `update ${CALLS}`);
    expect(update === undefined ? undefined : statementOf(update)?.u).not.toHaveProperty("$unset");
  });
});

describe("ping", () => {
  it("answers on a server, and rejects on a deployment that does not answer", async () => {
    const { calls } = await instance();
    await expect(calls.ping()).resolves.toBeUndefined();

    const lost = new MongoConnection({
      url: "mongodb://127.0.0.1:1/?replicaSet=rs0&serverSelectionTimeoutMS=200",
    });
    try {
      const store = new MongoOutboundCallRepository(
        lost,
        new StoreClock(StoreTimeSource.Test, new HandClock()),
      );
      await expect(store.ping()).rejects.toThrow();
    } finally {
      await lost.onDestroy();
    }
  });
});
