/**
 * agbossjs/agboss#789: the child queue's change stream notices a connection that dies silently —
 * through a TCP proxy that drops every byte with no FIN and no RST (`socket.destroy()` would be a
 * FIN). The instance warns within `mongodbWatchLivenessSeconds` (a ping every half, an answer due
 * in the other half, on the clock), opens the stream on a new client after the first pause, wakes
 * once (the catch-up), then hears the next save. The driver alone takes 40 s to see such a
 * connection.
 */
import { ExecutionRecordStatus, LogLevel, type ChildExecutionQueueWatch } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { MongoClient } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MongoChildExecutionQueueRepository, MongoConnection } from "../../src/index.js";
import { BlackholeProxy } from "../support/blackhole-proxy.js";
import { TestApplicationContext } from "../support/application-context.js";
import { testDatabase } from "../support/database.js";
import { RecordingLogger } from "../support/recording-logger.js";
import { REPLICA_SET_URL } from "../support/server.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();
const LIVENESS_SECONDS = 10;
/** How long a new connection may take in real time (a loaded machine): a hang bound, not an assertion. */
const CONNECTS = { timeout: 20_000 };
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const child = (executionId: string) => ({
  tenantId: "default",
  executionId,
  rootExecutionId: "root-1",
  parentExecutionId: "root-1",
  rootWorkflow: "items-workflow",
  workflow: "item-workflow",
  depth: 2,
  status: ExecutionRecordStatus.Queued,
  run: "{}",
  queuedAt: new Date("2026-01-05T09:00:00Z"),
});

/**
 * One more write after a save, so that the cluster time a new stream starts at (the cluster time
 * of its `ping`, inclusive) is past the save: the stream then does not replay it.
 */
async function writeAfter(connection: MongoConnection): Promise<void> {
  await connection.db.collection("clusterTime").insertOne({ at: new Date() });
}

/** The host and port of the replica set's primary (a direct connection needs it). */
async function primary(): Promise<{ readonly host: string; readonly port: number }> {
  const client = new MongoClient(REPLICA_SET_URL);
  try {
    const hello = await client.db("admin").command({ hello: 1 });
    const [host, port] = String(hello.primary).split(":");
    return { host: host ?? "localhost", port: Number(port) };
  } finally {
    await client.close();
  }
}

async function instances() {
  const proxy = await BlackholeProxy.start(await primary());
  cleanups.push(() => proxy.close());
  const through = `mongodb://127.0.0.1:${String(proxy.port)}/${database.name()}?directConnection=true`;
  const connection = new MongoConnection({
    url: through,
    watchLivenessSeconds: LIVENESS_SECONDS,
  });
  cleanups.push(() => connection.onDestroy());
  const clock = new VirtualClock();
  const logger = new RecordingLogger();
  const queueOn = (conn: MongoConnection, id: string, log: RecordingLogger) =>
    new MongoChildExecutionQueueRepository(conn, clock, new TestApplicationContext({}, id), log);
  const directConnection = connectionTo(database.url());
  return {
    proxy,
    clock,
    logger,
    directConnection,
    watched: queueOn(connection, "instance-2", logger),
    direct: queueOn(directConnection, "instance-1", new RecordingLogger()),
  };
}

async function watching(queue: MongoChildExecutionQueueRepository) {
  let wakes = 0;
  const watch: ChildExecutionQueueWatch = await queue.watchQueued(() => {
    wakes += 1;
  });
  cleanups.push(() => watch.close());
  return { wakes: () => wakes };
}

describe("agbossjs/agboss#789: the child queue's change stream on a silently dead connection", () => {
  it("warns within the bound, opens again, wakes once and hears the next save", async () => {
    const { proxy, clock, logger, watched, direct, directConnection } = await instances();
    const watch = await watching(watched);
    expect(logger.entries).toEqual([]);

    proxy.cut();
    // a ping goes out at the first half of the bound; its answer is due at the second
    await clock.advance(seconds(LIVENESS_SECONDS / 2));
    expect(logger.entries).toEqual([]);
    await clock.advance(seconds(LIVENESS_SECONDS / 2));

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      level: LogLevel.Warn,
      code: "child-queue.watch-connection-lost",
    });
    expect(watch.wakes()).toBe(0);

    // a child queued once the connection is known to be dead: the instance wakes at the new stream
    await direct.saveIfAbsent(child("c-1"));
    await writeAfter(directConnection);
    await clock.advance(seconds(1));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBe(1);
    }, CONNECTS);
    await direct.saveIfAbsent(child("c-2"));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBe(2);
    }, CONNECTS);
    expect(await direct.claimFirstByStatusQueuedOrderByDepthDesc()).toMatchObject({
      executionId: "c-1",
    });
    expect(logger.entries).toHaveLength(1);
  });

  it("a new client the network swallows gives up within the bound and is retried", async () => {
    const { proxy, clock, logger, watched } = await instances();
    const watch = await watching(watched);

    proxy.cut();
    proxy.swallowNew(true);
    await clock.advance(seconds(LIVENESS_SECONDS / 2));
    await clock.advance(seconds(LIVENESS_SECONDS / 2));
    expect(logger.entries).toHaveLength(1);
    await clock.advance(seconds(1));
    // the new client is swallowed: nothing answers its first ping, so it is dropped at the bound
    await clock.advance(seconds(LIVENESS_SECONDS));
    expect(watch.wakes()).toBe(0);

    proxy.swallowNew(false);
    await clock.advance(seconds(2));
    await vi.waitFor(() => {
      expect(watch.wakes()).toBe(1);
    }, CONNECTS);
  });
});
