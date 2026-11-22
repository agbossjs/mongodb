/**
 * agbossjs/mongodb#103: `hasCode`, the test of a server error by its code, on values given by hand: no
 * server, no hook, so a mutant of it is killed by this file and never by what it leaves running.
 */
import { describe, expect, it } from "vitest";
import { hasCode } from "../../src/stores/keys.js";

describe("hasCode", () => {
  it.each([
    ["an error with the code", { code: 11000 }, 11000, true],
    ["an error with another code", { code: 11001 }, 11000, false],
    ["an error with no code", { message: "x" }, 11000, false],
    ["a code that is a text", { code: "11000" }, 11000, false],
    ["null", null, 11000, false],
    ["a text", "E11000", 11000, false],
    ["undefined", undefined, 11000, false],
    ["a number", 11000, 11000, false],
  ])("%s", (_name, error, code, expected) => {
    expect(hasCode(error, code)).toBe(expected);
  });
});
