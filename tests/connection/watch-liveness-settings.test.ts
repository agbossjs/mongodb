/**
 * agbossjs/agboss#1029: `watchLivenessSeconds` of a settings object (a script's, a `useValue`
 * provider's) is checked as the environment's `mongodbWatchLivenessSeconds` is — a whole number of at least 2 — and a
 * value the watch cannot run on is a `MongoSettingsError` naming the field, not a watch that fails later.
 */
import { describe, expect, it } from "vitest";
import { MongoConnection, MongoSettingsError } from "../../src/index.js";
import { revealing, TestApplicationContext } from "../support/application-context.js";

const URL = "mongodb://db:27017/app?replicaSet=rs0";
const REFUSED = [0, 1, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY];

describe("agbossjs/agboss#1029: the watch's liveness bound in a settings object", () => {
  it.each(REFUSED)(
    "AC1: watchLivenessSeconds { %s } is a MongoSettingsError naming the field",
    (value) => {
      expect(() => new MongoConnection({ url: URL, watchLivenessSeconds: value })).toThrow(
        MongoSettingsError,
      );
      expect(() => new MongoConnection({ url: URL, watchLivenessSeconds: value })).toThrow(
        /watchLivenessSeconds must be a whole number of at least 2/,
      );
    },
  );

  it.each([2, 10])("AC1: watchLivenessSeconds { %s } is accepted", async (value) => {
    const connection = new MongoConnection({ url: URL, watchLivenessSeconds: value });
    expect(connection).toBeInstanceOf(MongoConnection);
    await connection.onDestroy();
  });

  it("AC1: no bound set is accepted (the default)", async () => {
    const connection = new MongoConnection({ url: URL });
    expect(connection).toBeInstanceOf(MongoConnection);
    await connection.onDestroy();
  });

  it("AC2: the environment path is unchanged: its field is still named, as before", () => {
    const environment = (value: number) =>
      new TestApplicationContext({
        mongodbUrl: revealing(URL),
        mongodbWatchLivenessSeconds: value,
      });
    expect(() => new MongoConnection(environment(1))).toThrow(
      /mongodbWatchLivenessSeconds must be at least 2/,
    );
    expect(() => new MongoConnection(environment(2.5))).toThrow(
      /mongodbWatchLivenessSeconds must be a whole number/,
    );
  });
});
