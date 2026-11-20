/**
 * agbossjs/mongodb#99: the edges of the settings that the first tests of `settings.test.ts` pass
 * through — the URL's database only at the start of the string, a Secret that is none of the
 * shapes `reveal` can be read from, the problems told apart by the text between them.
 */
import { describe, expect, it } from "vitest";
import { MongoSettingsError } from "../../src/index.js";
import { databaseOfUrl, settingsOfEnvironment } from "../../src/connection/settings.js";
import { revealing } from "../support/application-context.js";

const URL = "mongodb://app:secret@db1,db2,db3/?replicaSet=rs0";

describe("databaseOfUrl: only a connection string names a database", () => {
  it.each([
    "x mongodb://h1/orders",
    "see mongodb+srv://cluster.example.net/billing",
    "http://h1/orders?next=mongodb://h2/other",
  ])("a text that holds a connection string, but is not one, names none: %s", (text) => {
    expect(databaseOfUrl(text)).toBeUndefined();
  });
});

describe("a mongodbUrl that is no Secret is told so, never read through", () => {
  it.each([
    ["null", null],
    ["a number", 7],
    ["an object with no reveal", {}],
    ["an object whose reveal is a text", { reveal: URL }],
    ["an object whose reveal is a number", { reveal: 1 }],
  ])("%s", (_name, value) => {
    const failure = (): unknown => settingsOfEnvironment({ mongodbUrl: value });

    expect(failure).toThrow(MongoSettingsError);
    expect(failure).toThrow(/mongodbUrl must be a Secret/);
  });

  it("a Secret whose reveal is a function is read", () => {
    expect(settingsOfEnvironment({ mongodbUrl: revealing(URL) }).url).toBe(URL);
  });
});

describe("the problems of an environment are told apart", () => {
  it("two problems are one message, joined by a semicolon", () => {
    const failure = (): unknown =>
      settingsOfEnvironment({
        mongodbUrl: revealing(URL),
        mongodbDatabase: "",
        mongodbTransactionReadConcern: "local",
      });

    expect(failure).toThrow(
      new MongoSettingsError({
        message:
          "the MongoDB stores need their environment fields — mongodbDatabase is empty; mongodbTransactionReadConcern must be snapshot or majority",
      }),
    );
  });
});
