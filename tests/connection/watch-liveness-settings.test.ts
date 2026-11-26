/**
 * agbossjs/agboss#1029: `watchLivenessSeconds` of a settings object (a script's, a `useValue`
 * provider's) is checked as the driver's `timeouts.watchLiveness` is — a whole number of seconds, at least 2 — and a
 * value the watch cannot run on is a `MongoSettingsError` naming the field, not a watch that fails later.
 */
import { describe, expect, it } from "vitest";
import { MongoConnection, MongoSettingsError } from "../../src/index.js";
import { revealing } from "../support/application-context.js";

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

  it("AC2: the driver path is checked the same: its liveness (ms) in whole seconds, at least 2", () => {
    const resolved = (watchLiveness: number) => ({
      kind: "mongodb",
      url: revealing(URL),
      watchLiveness,
    });
    expect(() => new MongoConnection(resolved(1000))).toThrow(
      /watchLivenessSeconds must be a whole number of at least 2/,
    );
    expect(() => new MongoConnection(resolved(0))).toThrow(
      /watchLivenessSeconds must be a whole number of at least 2/,
    );
  });
});
