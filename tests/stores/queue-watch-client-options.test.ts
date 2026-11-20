/**
 * agbossjs/agboss#81: the options of the client the child queue's watch runs on, each one a bound
 * of the stop or of the liveness proof (agbossjs/agboss#789, #1027, #1088): one connection (the
 * stream's `getMore`s and the ping take turns on it), no retries (the watch reopens itself), a
 * connection up in half the liveness bound, every other wait bounded by the whole of it, the
 * monitor looking every quarter; and the enforced concerns of every client of the package.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MongoConnection } from "../../src/index.js";
import { watchClientOf } from "../../src/connection/watch-client.js";
import { REPLICA_SET_URL } from "../support/server.js";

const LIVENESS_SECONDS = 8;
const made: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const client of made.splice(0)) await client.close();
});

function watchClient(monitorCommands: boolean) {
  const connection = new MongoConnection({
    url: REPLICA_SET_URL,
    watchLivenessSeconds: LIVENESS_SECONDS,
  });
  const watch = watchClientOf(connection, { monitorCommands });
  made.push(watch.client);
  return watch;
}

describe("agbossjs/agboss#81: the watch's client", () => {
  it("is made of a MongoConnection's settings only", () => {
    expect(() => watchClientOf({})).toThrowError("a MongoConnection made outside its constructor");
  });

  it("has one connection, no retries, and every wait bounded by the liveness bound", () => {
    const { client, livenessSeconds } = watchClient(false);

    expect(livenessSeconds).toBe(LIVENESS_SECONDS);
    expect(client.options).toMatchObject({
      maxPoolSize: 1,
      retryReads: false,
      retryWrites: false,
      connectTimeoutMS: (LIVENESS_SECONDS / 2) * 1000,
      serverSelectionTimeoutMS: LIVENESS_SECONDS * 1000,
      socketTimeoutMS: LIVENESS_SECONDS * 1000,
      heartbeatFrequencyMS: (LIVENESS_SECONDS / 4) * 1000,
      ignoreUndefined: true,
    });
  });

  it("carries the enforced concerns of every client of the package", () => {
    const { client } = watchClient(false);

    expect(client.options.writeConcern).toMatchObject({ w: "majority", journal: true });
    expect(client.options.readConcern).toMatchObject({ level: "majority" });
    expect(client.options.readPreference.mode).toBe("primary");
  });

  it.each([true, false])("monitors commands only when asked (asked: %s)", (monitorCommands) => {
    expect(watchClient(monitorCommands).client.options.monitorCommands).toBe(monitorCommands);
  });

  it("looks every quarter of the bound, at the least bound of 2 s every half second", () => {
    const connection = new MongoConnection({ url: REPLICA_SET_URL, watchLivenessSeconds: 2 });
    const { client } = watchClientOf(connection);
    made.push(client);

    expect(client.options.heartbeatFrequencyMS).toBe(500);
  });
});
