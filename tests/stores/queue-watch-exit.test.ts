/**
 * agbossjs/agboss#1027: after the watch's `close()` and `MongoConnection.onDestroy()` nothing the
 * watch opened keeps the process alive past `EXIT_BOUND` times `mongodbWatchLivenessSeconds` — not
 * the client dropped as silent, not a reconnect the network swallowed. Probed out of process: a
 * child opens the watch through a black-hole proxy, the parent cuts the network, tells it to close
 * and watches how long the process lives.
 */
import { afterEach, describe, expect, it } from "vitest";
import { testDatabase } from "../support/database.js";
import { BlackholeProxy } from "../support/blackhole-proxy.js";
import { ExitProbe } from "../support/exit-probe.js";
import { REPLICA_SET_URL } from "../support/server.js";
import { MongoClient } from "mongodb";

const database = testDatabase();
const LIVENESS_SECONDS = 4;
/** The documented bound: the process is gone this many livenesses after the close. */
const EXIT_BOUND = 2;
/** The process's own start and stop, outside the bound (a loaded machine). */
const SLACK_MS = 2000;
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A probe on the replica set's primary through a black-hole proxy, its watch open. */
async function opened(): Promise<{ readonly proxy: BlackholeProxy; readonly probe: ExitProbe }> {
  const client = new MongoClient(REPLICA_SET_URL);
  const hello = await client.db("admin").command({ hello: 1 });
  await client.close();
  const [host = "127.0.0.1", port = "27017"] = String(hello.primary).split(":");
  const proxy = await BlackholeProxy.start({ host, port: Number(port) });
  cleanups.push(() => proxy.close());
  const url = `mongodb://127.0.0.1:${String(proxy.port)}/${database.name()}?directConnection=true`;
  const probe = ExitProbe.start(url, LIVENESS_SECONDS);
  cleanups.push(() => {
    probe.kill();
  });
  await probe.told("ready");
  return { proxy, probe };
}

const EXITS = EXIT_BOUND * LIVENESS_SECONDS * 1000 + SLACK_MS;

describe("agbossjs/agboss#1027: the process exits after the watch's close", () => {
  it("control: a healthy watch's process exits at once", async () => {
    const { probe } = await opened();

    expect(await probe.closeAndExit(EXITS)).toBe("returned");
  }, 90_000);

  it("AC1/AC3: the stream's leg is black-holed and new connections are swallowed: it exits within the bound", async () => {
    const { proxy, probe } = await opened();
    proxy.cut();
    proxy.swallowNew(true);
    await probe.told("warned");
    // at least three attempts to connect again, all swallowed
    const before = proxy.accepted;
    while (proxy.accepted < before + 3) await new Promise((resolve) => setTimeout(resolve, 100));

    expect(await probe.closeAndExit(EXITS)).toBe("returned");
  }, 90_000);

  it("AC2/AC3: the network comes back and the watch reconnects: it exits within the bound", async () => {
    const { proxy, probe } = await opened();
    proxy.cut();
    proxy.swallowNew(true);
    await probe.told("warned");
    proxy.swallowNew(false);
    await probe.told("woke");

    expect(await probe.closeAndExit(EXITS)).toBe("returned");
  }, 90_000);
});
