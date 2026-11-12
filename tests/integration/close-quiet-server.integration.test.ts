/**
 * agbossjs/agboss#923 — an instance's stop ends while the MongoDB server has gone quiet (`docker
 * pause`: sockets open, nothing answered): `MongoConnection.onDestroy` does not wait for the
 * driver's close, which waits on the server (35 s, until the unpause, before); an operation in
 * flight rejects; nothing rejects unhandled when the server comes back.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SchemaSetup } from "@agboss/core/stores";
import { MongoConnection } from "../../src/index.js";
import {
  endsWithin,
  HAS_DOCKER,
  type PausableServer,
  RealClock,
  sleep,
  startMongo,
  watchUnhandled,
} from "../support/pause.js";
import { freshDatabaseName } from "../support/server.js";

/** Longer than the close's grace, far shorter than a stop's timeout. */
const MARGIN_MS = 4000;

let server: PausableServer;
beforeAll(async () => {
  server = await startMongo();
}, 120_000);
afterEach(() => {
  server.unpause();
});
afterAll(() => {
  server.remove();
});

async function connected(): Promise<MongoConnection> {
  const connection = new MongoConnection(
    {
      url: server.url,
      database: freshDatabaseName(),
      schemaSetup: SchemaSetup.MigrateOnStart,
    },
    new RealClock(),
  );
  await connection.onInit();
  return connection;
}

describe.skipIf(!HAS_DOCKER)("#923: onDestroy against a paused MongoDB", () => {
  it("idle: onDestroy returns, no unhandled rejection after the unpause", async () => {
    const unhandled = watchUnhandled();
    const connection = await connected();
    server.pause();
    await sleep(500);

    const outcome = await endsWithin(connection.onDestroy(), MARGIN_MS);
    server.unpause();
    await sleep(2000);
    unhandled.stop();

    expect(outcome).toBe("returned");
    expect(unhandled.seen).toEqual([]);
  });

  it("with an operation in flight (a running execution's call): onDestroy returns, the operation rejects", async () => {
    const unhandled = watchUnhandled();
    const connection = await connected();
    server.pause();
    await sleep(500);
    const failed = connection.ping().then(
      () => "answered",
      () => "rejected",
    );

    const outcome = await endsWithin(connection.onDestroy(), MARGIN_MS);
    server.unpause();
    await sleep(2000);
    unhandled.stop();

    expect(outcome).toBe("returned");
    expect(await failed).toBe("rejected");
    expect(unhandled.seen).toEqual([]);
  });
});
