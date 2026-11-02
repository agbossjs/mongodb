import { describe, expect, it } from "vitest";
import { DEFAULT_DATABASE, MongoSettingsError, TransactionReadConcern } from "../../src/index.js";
import { databaseOfUrl, settingsOfEnvironment } from "../../src/connection/settings.js";
import { revealing } from "../support/application-context.js";

const URL = "mongodb://app:secret@db1,db2,db3/?replicaSet=rs0";

describe("the environment fields of the MongoDB stores", () => {
  it("mongodbUrl is a Secret: its revealed value is the URL; the others are optional", () => {
    expect(settingsOfEnvironment({ mongodbUrl: revealing(URL) })).toEqual({
      url: URL,
      database: undefined,
      transactionReadConcern: undefined,
    });
    expect(DEFAULT_DATABASE).toBe("agboss");
  });

  it("mongodbDatabase and mongodbTransactionReadConcern are read when set", () => {
    const settings = settingsOfEnvironment({
      mongodbUrl: revealing(URL),
      mongodbDatabase: "desk",
      mongodbTransactionReadConcern: "majority",
    });

    expect(settings).toEqual({
      url: URL,
      database: "desk",
      transactionReadConcern: TransactionReadConcern.Majority,
    });
  });

  it("snapshot is the other transaction read concern", () => {
    const settings = settingsOfEnvironment({
      mongodbUrl: revealing(URL),
      mongodbTransactionReadConcern: "snapshot",
    });

    expect(settings.transactionReadConcern).toBe(TransactionReadConcern.Snapshot);
  });

  it("a missing mongodbUrl fails, naming the field and how to declare it", () => {
    expect(() => settingsOfEnvironment({})).toThrow(MongoSettingsError);
    expect(() => settingsOfEnvironment({})).toThrow(
      /mongodbUrl is missing: declare mongodbUrl!: Secret/,
    );
  });

  it("an environment that is not an object fails with the named error", () => {
    expect(() => settingsOfEnvironment(undefined)).toThrow(MongoSettingsError);
    expect(() => settingsOfEnvironment(undefined)).toThrow(/need their environment fields/);
  });

  it("a mongodbUrl that is a plain string, not a Secret, fails without printing it", () => {
    const failure = (): unknown => settingsOfEnvironment({ mongodbUrl: URL });

    expect(failure).toThrow(/mongodbUrl must be a Secret/);
    expect(failure).not.toThrow(/secret@db/);
  });

  it("an empty mongodbUrl fails", () => {
    expect(() => settingsOfEnvironment({ mongodbUrl: revealing("") })).toThrow(
      "mongodbUrl is empty",
    );
  });

  it.each([
    [{ mongodbDatabase: "" }, /mongodbDatabase is empty/],
    [{ mongodbDatabase: 7 }, /mongodbDatabase must be a text/],
    [{ mongodbTransactionReadConcern: "local" }, /must be snapshot or majority/],
    [{ mongodbTransactionReadConcern: "available" }, /must be snapshot or majority/],
    [{ mongodbTransactionReadConcern: true }, /must be snapshot or majority/],
  ])("a mistyped field fails, naming it: %o", (fields, message) => {
    expect(() => settingsOfEnvironment({ mongodbUrl: revealing(URL), ...fields })).toThrow(message);
  });

  it("every problem is listed at once", () => {
    const failure = (): unknown =>
      settingsOfEnvironment({ mongodbDatabase: "", mongodbTransactionReadConcern: "local" });

    expect(failure).toThrow(
      /mongodbUrl is missing.*mongodbDatabase is empty.*snapshot or majority/,
    );
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
