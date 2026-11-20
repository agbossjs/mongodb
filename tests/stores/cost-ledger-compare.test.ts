/**
 * agbossjs/mongodb#93: the order of the counters' ids (`compareStrings`), by code unit, each of its
 * three answers — the counters of a save are written in this one order, whichever instance saves.
 */
import { describe, expect, it } from "vitest";
import { compareStrings } from "../../src/stores/mongo-cost-ledger.repository.js";

describe("agbossjs/mongodb#93: compareStrings", () => {
  it.each([
    ["a", "b", -1],
    ["b", "a", 1],
    ["a", "a", 0],
    ["a", "ab", -1],
    ["ab", "a", 1],
    ["Z", "a", -1],
    ["", "a", -1],
  ] as const)("%j against %j is %d", (left, right, expected) => {
    expect(compareStrings(left, right)).toBe(expected);
  });

  it("sorts as the code units do", () => {
    expect(["b", "a", "B", "ab"].sort(compareStrings)).toEqual(["B", "a", "ab", "b"]);
  });
});
