import { describe, expect, it } from "vitest";
import {
  DEFAULT_DATABASE,
  DEFAULT_WATCH_LIVENESS_SECONDS,
  MongoSettingsError,
} from "../../src/index.js";
import { databaseOfUrl } from "../../src/connection/settings.js";

describe("the settings of the MongoDB stores", () => {
  it("the defaults a driver without the option leaves", () => {
    expect(DEFAULT_DATABASE).toBe("agboss");
    expect(DEFAULT_WATCH_LIVENESS_SECONDS).toBe(10);
  });

  it("the error has its stable code", () => {
    expect(MongoSettingsError.code).toBe("mongodb.settings-invalid");
  });
});

describe("databaseOfUrl: the database a connection string names", () => {
  it.each([
    ["mongodb://h1:1,h2:2/orders?replicaSet=rs0", "orders"],
    ["mongodb+srv://cluster.example.net/billing", "billing"],
    ["mongodb://h1/my%20db", "my db"],
    ["mongodb://h1/?replicaSet=rs0", undefined],
    ["mongodb://h1", undefined],
    ["mongodb://h1/", undefined],
  ])("%s → %s", (url, database) => {
    expect(databaseOfUrl(url)).toBe(database);
  });
});
