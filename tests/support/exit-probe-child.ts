/**
 * The process of an exit probe (agbossjs/agboss#1027), run by `tsx` from `exit-probe.ts`: it opens
 * a connection (the URL and the bound in argv) and the child queue's watch on a real clock, tells
 * its parent what happens over IPC, and on `close` closes the watch and the connection — then does
 * nothing more: how long the process lives afterwards is what the parent measures.
 */
import { Logger, type LogEntry } from "@agboss/core";
import { MongoChildExecutionQueueRepository, MongoConnection } from "../../src/index.js";
import { TestApplicationContext } from "./application-context.js";
import { RealClock } from "./pause.js";

const [url = "", liveness = "10"] = process.argv.slice(2);
const tell = (type: string): void => {
  process.send?.({ type });
};

class TellingLogger extends Logger {
  write(entry: LogEntry): void {
    if (entry.code === "child-queue.watch-connection-lost") tell("warned");
  }
}

const clock = new RealClock();
const connection = new MongoConnection({ url, watchLivenessSeconds: Number(liveness) }, clock);
const queue = new MongoChildExecutionQueueRepository(
  connection,
  clock,
  new TestApplicationContext({}, "probe"),
  new TellingLogger(),
);
const watch = await queue.watchQueued(() => {
  tell("woke");
});
process.on("message", (message: { type?: string }) => {
  if (message.type !== "close") return;
  void (async () => {
    await watch.close();
    await connection.onDestroy();
    tell("closed");
    process.disconnect();
  })();
});
tell("ready");
