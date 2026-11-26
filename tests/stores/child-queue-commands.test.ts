/**
 * agbossjs/agboss#1213: the child queue beyond the contract. The claim takes the deepest child,
 * then the longest waiting, and gives it back as claimed; a child running under any claim is not
 * queued again by a caller that names none; of the errors of a save only the duplicate key is
 * `false`; a completion without a failure removes the failure a row had; the depth reads only the
 * queued and running rows.
 */
import { ExecutionRecordStatus, type QueuedChildExecution } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { MongoServerError, type Collection, type Db } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collections, MongoChildExecutionQueueRepository } from "../../src/index.js";
import { idOf } from "../../src/stores/keys.js";
import { TestApplicationContext } from "../support/application-context.js";
import { commandsOf, type Sent } from "../support/command-log.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { RecordingLogger } from "../support/recording-logger.js";
import { connectionTo } from "../support/stores.js";

vi.mock("mongodb", async (importOriginal) => {
  const { reportingCommands } = await import("../support/command-log.js");
  return reportingCommands(await importOriginal());
});

const database = testDatabase();
const QUEUE = Collections.ChildExecutionQueue;
const INSTANCE = "instance-1";
const START = Date.parse("2026-10-18T08:00:00.000Z");

beforeEach(() => emptyAll(database.url()));

interface RawChild {
  _id: string;
  status?: string;
  failure?: string;
  endedAt?: Date;
}

const rawQueue = () => connectionTo(database.url()).db.collection<RawChild>(QUEUE);

const child = (executionId: string, depth: number, queuedAfter: number): QueuedChildExecution => ({
  tenantId: "default",
  executionId,
  rootExecutionId: "root",
  parentExecutionId: "parent",
  rootWorkflow: "workflow",
  workflow: "child-workflow",
  depth,
  status: ExecutionRecordStatus.Queued,
  run: "{}",
  queuedAt: new Date(START + queuedAfter),
});

/** `target[key]`, a method bound to `target`. */
function boundMember(target: object, key: string | symbol): unknown {
  const value: unknown = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
}

function queueOn(clock = new VirtualClock()): {
  queue: MongoChildExecutionQueueRepository;
  log: Sent[];
  connection: ReturnType<typeof connectionTo>;
} {
  const connection = connectionTo(database.url());
  const log = commandsOf(connection);
  const queue = new MongoChildExecutionQueueRepository(
    connection,
    clock,
    new TestApplicationContext(INSTANCE),
    new RecordingLogger(),
  );
  return { queue, log, connection };
}

describe("agbossjs/agboss#1213: the claim", () => {
  it("takes the deepest queued child, then the longest waiting, and gives it back as claimed", async () => {
    const clock = new VirtualClock();
    const { queue } = queueOn(clock);
    for (const one of [child("a", 2, 0), child("b", 3, 2000), child("c", 3, 1000)])
      expect(await queue.saveIfAbsent(one)).toBe(true);

    for (const executionId of ["c", "b", "a"]) {
      const claimed = await queue.claimFirstByStatusQueuedOrderByDepthDesc();
      expect(claimed).toMatchObject({
        executionId,
        status: ExecutionRecordStatus.Running,
        instanceId: INSTANCE,
        claimedAt: clock.now(),
      });
    }
    expect(await queue.claimFirstByStatusQueuedOrderByDepthDesc()).toBeUndefined();
  });
});

describe("agbossjs/agboss#1213: a save", () => {
  it("a child running under a claim is not queued again by a caller that names no claim", async () => {
    const { queue } = queueOn();
    await queue.saveIfAbsent(child("run", 2, 0));
    await queue.claimFirstByStatusQueuedOrderByDepthDesc();

    expect(await queue.saveIfAbsent(child("run", 2, 0))).toBe(false);

    expect((await rawQueue().findOne({ _id: idOf("default", "run") }))?.status).toBe(
      ExecutionRecordStatus.Running,
    );
  });

  it("answers a duplicate key with false, and fails on any other error", async () => {
    const { queue, connection } = queueOn();
    const db = connection.db;
    const failing = (error: Error, afterDone: boolean): Db =>
      new Proxy(db, {
        get(target, key) {
          if (key !== "collection") return boundMember(target, key);
          return (...args: Parameters<Db["collection"]>) => {
            const real: Collection = target.collection(...args);
            return new Proxy(real, {
              get(inner, name) {
                if (name !== "updateOne") return boundMember(inner, name);
                return async (...updateArgs: Parameters<Collection["updateOne"]>) => {
                  if (afterDone) await inner.updateOne(...updateArgs);
                  throw error;
                };
              },
            });
          };
        },
      });
    const serverError = (code: number) =>
      new MongoServerError({ code, errmsg: `error ${String(code)}` });

    Object.defineProperty(connection, "db", { value: failing(serverError(11000), true) });
    expect(await queue.saveIfAbsent(child("dup", 2, 0))).toBe(false);
    expect((await rawQueue().findOne({ _id: idOf("default", "dup") }))?.status).toBe(
      ExecutionRecordStatus.Queued,
    );

    for (const error of [serverError(13), new Error("the connection was lost")]) {
      Object.defineProperty(connection, "db", { value: failing(error, false) });
      await expect(queue.saveIfAbsent(child("other", 2, 0))).rejects.toBe(error);
    }
  });
});

describe("agbossjs/agboss#1213: a completion", () => {
  it("without a failure removes the one the row had; with one it stores it", async () => {
    const clock = new VirtualClock();
    const { queue } = queueOn(clock);
    await queue.saveIfAbsent(child("end", 2, 0));
    await queue.claimFirstByStatusQueuedOrderByDepthDesc();
    const id = idOf("default", "end");
    await rawQueue().updateOne({ _id: id }, { $set: { failure: "old" } });

    expect(
      await queue.completeByTenantIdAndExecutionId("default", "end", {
        status: ExecutionRecordStatus.Answered,
      }),
    ).toBe(true);

    const done = await rawQueue().findOne({ _id: id });
    expect(done).toMatchObject({ status: ExecutionRecordStatus.Answered, endedAt: clock.now() });
    expect(done).not.toHaveProperty("failure");

    await queue.saveIfAbsent(child("bad", 2, 0));
    await queue.claimFirstByStatusQueuedOrderByDepthDesc();
    await queue.completeByTenantIdAndExecutionId("default", "bad", {
      status: ExecutionRecordStatus.Failed,
      failure: "boom",
    });
    expect(await rawQueue().findOne({ _id: idOf("default", "bad") })).toMatchObject({
      status: ExecutionRecordStatus.Failed,
      failure: "boom",
    });
  });
});

describe("agbossjs/agboss#1213: the depth", () => {
  it("is one aggregation over the queued and running rows only", async () => {
    const { queue, log } = queueOn();
    await queue.saveIfAbsent(child("q", 2, 0));

    expect(await queue.countByStatus()).toEqual({
      queued: 1,
      running: 0,
      oldestQueuedAt: new Date(START),
    });

    const aggregate = log.find((one) => one.name === "aggregate");
    expect(aggregate?.command.pipeline[0]).toEqual({
      $match: { status: { $in: [ExecutionRecordStatus.Queued, ExecutionRecordStatus.Running] } },
    });
  });
});
