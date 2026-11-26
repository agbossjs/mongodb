/**
 * agbossjs/mongodb#99: the edges of the settings that the first tests of `settings.test.ts` pass
 * through — the URL's database only at the start of the string.
 */
import { describe, expect, it } from "vitest";
import { databaseOfUrl } from "../../src/connection/settings.js";

describe("databaseOfUrl: only a connection string names a database", () => {
  it.each([
    "x mongodb://h1/orders",
    "see mongodb+srv://cluster.example.net/billing",
    "http://h1/orders?next=mongodb://h2/other",
  ])("a text that holds a connection string, but is not one, names none: %s", (text) => {
    expect(databaseOfUrl(text)).toBeUndefined();
  });
});
