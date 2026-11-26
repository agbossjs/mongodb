/**
 * agbossjs/agboss#954 — an application's stop against a MongoDB server gone quiet (`docker pause`:
 * sockets open, nothing answered): `close({ timeout })` ends, no socket to the server is left open
 * (the connection's client, the child queue's change-stream client, its kill client), an
 * `execute()` the stop abandons settles with `ApplicationStoppingError` (AC3). Sockets are counted
 * by `destroyed`. The server is a container of the test's own; without Docker, skipped.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ApplicationStoppingError, createApp } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { migrateMongodb } from "../../src/index.js";
import {
  HAS_DOCKER,
  type PausableServer,
  sleep,
  startMongo,
  trackSockets,
  watchUnhandled,
} from "../support/pause.js";
import { StopApplication, StopBatchStart } from "../fixtures/stop/stop.application.js";

let server: PausableServer;
beforeAll(async () => {
  if (!HAS_DOCKER) return;
  server = await startMongo();
  await migrateMongodb({ url: server.url, database: "agboss_stop" });
  process.env.AGBOSS_STOP_DATABASE_URL = `${server.url}&connectTimeoutMS=3000`;
  process.env.AGBOSS_STOP_OPENROUTER_KEY = "placeholder";
}, 180_000);
afterEach(async () => {
  if (HAS_DOCKER) await server.unpause();
});
afterAll(async () => {
  if (HAS_DOCKER) await server.remove();
});

/**
 * A connection attempt whose handshake the quiet server never answers belongs to no one the driver
 * lets go of: it ends by its own `connectTimeoutMS` (3 s here), so within that every socket is gone.
 */
async function closedAgainstPausedServer(running: boolean): Promise<{
  readonly established: number;
  readonly open: number;
  readonly unhandled: unknown[];
  readonly outcome: unknown;
}> {
  const port = Number(new URL(server.url.replace("mongodb://", "http://")).port);
  const unhandled = watchUnhandled();
  const sockets = trackSockets(port);
  try {
    const app = await createApp(StopApplication);
    let outcome: unknown = "none";
    if (running) {
      app.execute(StopBatchStart, [{ name: "a" }, { name: "b" }] as never).then(
        () => (outcome = "answered"),
        (error: unknown) => (outcome = error),
      );
      await sleep(2000);
    }
    await sleep(500);
    await server.pause();
    await sleep(1000);

    await app.close({ timeout: seconds(5) });
    const established = sockets.established(); // at once: the close left none that heard the server
    for (let waited = 0; sockets.open() > 0 && waited < 6000; waited += 250) await sleep(250);
    const open = sockets.open();
    await server.unpause();
    await sleep(500);
    return { established, open, unhandled: unhandled.seen, outcome };
  } finally {
    sockets.stop();
    unhandled.stop();
    await server.unpause();
  }
}

describe.skipIf(!HAS_DOCKER)("#954: close() against a paused MongoDB leaves no socket open", () => {
  it("an idle application: every socket to the server is destroyed after close()", async () => {
    const { established, open, unhandled } = await closedAgainstPausedServer(false);

    expect(established).toBe(0);
    expect(open).toBe(0);
    expect(unhandled).toEqual([]);
  }, 90_000);

  it("with executions running: every socket is destroyed, the abandoned execute() settles with ApplicationStoppingError (AC3)", async () => {
    const { established, open, unhandled, outcome } = await closedAgainstPausedServer(true);

    expect(established).toBe(0);
    expect(open).toBe(0);
    expect(unhandled).toEqual([]);
    expect(outcome).toBeInstanceOf(ApplicationStoppingError);
    expect(outcome).toMatchObject({ code: "app.stopping" });
  }, 90_000);
});
