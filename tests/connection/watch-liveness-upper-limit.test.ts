/**
 * agbossjs/agboss#1129: a timer-backed duration has an upper limit. `watchLivenessSeconds` above
 * `MAX_WATCH_LIVENESS_SECONDS` (3600) is a `MongoSettingsError` naming the field on both paths — a
 * Node timer holds at most 2^31-1 ms, and 2147484 s made the watch fail at once and the instance
 * silently fall back to the sweep. The connection copies the settings object it is given.
 */
import { describe, expect, it } from "vitest";
import { MongoConnection, MongoSettingsError } from "../../src/index.js";
import { MAX_WATCH_LIVENESS_SECONDS } from "../../src/connection/settings.js";
import { watchClientOf } from "../../src/connection/watch-client.js";
import { revealing, TestApplicationContext } from "../support/application-context.js";

const URL = "mongodb://db:27017/app?replicaSet=rs0";
const TOO_LONG = [3601, 86_400, 2_147_483, 2_147_484, 2 ** 31, Number.MAX_SAFE_INTEGER];

const environment = (value: number): TestApplicationContext =>
  new TestApplicationContext({ mongodbUrl: revealing(URL), mongodbWatchLivenessSeconds: value });

describe("agbossjs/agboss#1129: the watch's liveness bound has an upper limit", () => {
  it("AC1: the limit is far under what a Node timer holds", () => {
    expect(MAX_WATCH_LIVENESS_SECONDS).toBe(3600);
    expect(MAX_WATCH_LIVENESS_SECONDS * 1000).toBeLessThan(2 ** 31 - 1);
  });

  it.each(TOO_LONG)(
    "AC1: watchLivenessSeconds { %s } in a settings object is a MongoSettingsError naming the field",
    (value) => {
      const build = (): unknown => new MongoConnection({ url: URL, watchLivenessSeconds: value });
      expect(build).toThrow(MongoSettingsError);
      expect(build).toThrow(
        /watchLivenessSeconds must be a whole number of at least 2 and at most 3600/,
      );
      expect(build).not.toThrow(/db:27017/u);
    },
  );

  it.each(TOO_LONG)(
    "AC2: mongodbWatchLivenessSeconds { %s } in the environment is a MongoSettingsError naming the field",
    (value) => {
      const build = (): unknown => new MongoConnection(environment(value));
      expect(build).toThrow(MongoSettingsError);
      expect(build).toThrow(/mongodbWatchLivenessSeconds must be at most 3600/);
    },
  );

  it.each([2, 3600])(
    "AC3: the limit itself and the minimum, { %s }, are accepted on both paths",
    async (value) => {
      for (const connection of [
        new MongoConnection({ url: URL, watchLivenessSeconds: value }),
        new MongoConnection(environment(value)),
      ]) {
        expect(watchClientOf(connection).livenessSeconds).toBe(value);
        await connection.onDestroy();
      }
    },
  );

  it("AC4: the connection copies the settings: changing the object afterwards does not bypass the check", async () => {
    const settings: { url: string; watchLivenessSeconds?: number } = {
      url: URL,
      watchLivenessSeconds: 10,
    };
    const connection = new MongoConnection(settings);
    settings.watchLivenessSeconds = 2_147_484;
    settings.url = "mongodb://elsewhere:27017/?replicaSet=rs0";

    const watch = watchClientOf(connection);
    expect(watch.livenessSeconds).toBe(10);
    expect(watch.db.databaseName).toBe("app");
    await connection.onDestroy();
    await watch.client.close();
  });

  it("AC4: a settings object that was unset when built stays on the default", async () => {
    const settings: { url: string; watchLivenessSeconds?: number } = { url: URL };
    const connection = new MongoConnection(settings);
    settings.watchLivenessSeconds = 2_147_484;

    const watch = watchClientOf(connection);
    expect(watch.livenessSeconds).toBe(10);
    await connection.onDestroy();
    await watch.client.close();
  });
});
