import { ExecutionRecordStatus, type ChildExecutionQueueWatch, type Clock } from "@agboss/core";
import { MongoClient } from "mongodb";
import { MongoChildExecutionQueueRepository, MongoConnection } from "../../src/index.js";
import { BlackholeProxy } from "./blackhole-proxy.js";
import { TestApplicationContext } from "./application-context.js";
import type { TestDatabase } from "./database.js";
import { RecordingLogger } from "./recording-logger.js";
import { REPLICA_SET_URL } from "./server.js";
import { connectionTo } from "./stores.js";

/** What the watch tests of a store that dies silently share (agbossjs/agboss#789, #1028). */

/** How long a new connection may take in real time (a loaded machine): a hang bound, not an assertion. */
export const CONNECTS = { timeout: 20_000 };

export const child = (executionId: string): NewChildExecution => ({
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

/** What `saveIfAbsent` takes. */
type NewChildExecution = Parameters<MongoChildExecutionQueueRepository["saveIfAbsent"]>[0];

/** A watching instance behind a black-hole proxy, a direct one beside it, and the proxy's logger. */
export interface SilentInstances {
  readonly proxy: BlackholeProxy;
  readonly logger: RecordingLogger;
  readonly watched: MongoChildExecutionQueueRepository;
  readonly direct: MongoChildExecutionQueueRepository;
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

/** The instances of a test; `cleanups` end them. */
export async function instances(
  database: TestDatabase,
  cleanups: (() => Promise<void>)[],
  options: { readonly clock: Clock; readonly livenessSeconds: number },
): Promise<SilentInstances> {
  const proxy = await BlackholeProxy.start(await primary());
  cleanups.push(() => proxy.close());
  const through = `mongodb://127.0.0.1:${String(proxy.port)}/${database.name()}?directConnection=true`;
  const connection = new MongoConnection({
    url: through,
    watchLivenessSeconds: options.livenessSeconds,
  });
  cleanups.push(() => connection.onDestroy());
  const logger = new RecordingLogger();
  const queueOn = (conn: MongoConnection, id: string, log: RecordingLogger) =>
    new MongoChildExecutionQueueRepository(
      conn,
      options.clock,
      new TestApplicationContext({}, id),
      log,
    );
  return {
    proxy,
    logger,
    watched: queueOn(connection, "instance-2", logger),
    direct: queueOn(connectionTo(database.url()), "instance-1", new RecordingLogger()),
  };
}

/** A watch on `queue`, closed by `cleanups`, and how many times it woke. */
export async function watching(
  queue: MongoChildExecutionQueueRepository,
  cleanups: (() => Promise<void>)[],
): Promise<{ readonly wakes: () => number }> {
  let wakes = 0;
  const watch: ChildExecutionQueueWatch = await queue.watchQueued(() => {
    wakes += 1;
  });
  cleanups.push(() => watch.close());
  return { wakes: () => wakes };
}
