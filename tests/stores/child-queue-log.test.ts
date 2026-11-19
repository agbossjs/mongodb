/**
 * agbossjs/agboss#1213: what the child queue says without a server: its `ping` is the
 * connection's, and the warning of a watch that lost its connection is one exact log entry.
 */
import { LogLevel } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it, vi } from "vitest";
import { MongoChildExecutionQueueRepository } from "../../src/index.js";
import { MongoQueueWatch } from "../../src/stores/queue-watch.js";
import { TestApplicationContext } from "../support/application-context.js";
import { RecordingLogger } from "../support/recording-logger.js";
import { connectionTo } from "../support/stores.js";

function queueOn(clock: VirtualClock, logger: RecordingLogger) {
  const connection = connectionTo("mongodb://localhost:1/unused");
  const queue = new MongoChildExecutionQueueRepository(
    connection,
    clock,
    new TestApplicationContext({}),
    logger,
  );
  return { connection, queue };
}

describe("MongoChildExecutionQueueRepository: without a server", () => {
  it("ping is one ping of the connection", async () => {
    const { connection, queue } = queueOn(new VirtualClock(), new RecordingLogger());
    const ping = vi.spyOn(connection, "ping").mockResolvedValue();

    await queue.ping();

    expect(ping).toHaveBeenCalledOnce();
  });

  it("a watch that lost its connection warns once, with its code, its message and the clock's time", async () => {
    const clock = new VirtualClock();
    const logger = new RecordingLogger();
    const { queue } = queueOn(clock, logger);
    const open = vi
      .spyOn(MongoQueueWatch, "open")
      .mockImplementation(async (_connection, _clock, warn) => {
        warn("the stream went silent");
        return Object.create(MongoQueueWatch.prototype) as MongoQueueWatch;
      });

    await queue.watchQueued(() => undefined);

    expect(open).toHaveBeenCalledOnce();
    expect(logger.entries).toEqual([
      {
        level: LogLevel.Warn,
        code: "child-queue.watch-connection-lost",
        message: "the stream went silent",
        time: clock.now(),
      },
    ]);
  });
});
