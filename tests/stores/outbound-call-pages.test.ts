/**
 * The paged listing's arguments (agbossjs/agboss#825): what a refused limit or cursor says. The
 * core's contract case checks that both are refused; this file checks the words an operator reads.
 */
import { describe, expect, it } from "vitest";
import { pageLimitOf, seqOfCursor } from "../../src/stores/outbound-call-pages.js";

describe("the outbound call listing's arguments", () => {
  it("a limit that is no whole number from 1 is a RangeError naming the limit given", () => {
    expect(pageLimitOf(1)).toBe(1);
    expect(() => pageLimitOf(0.5)).toThrow(
      new RangeError("a page's limit is a whole number of calls from 1, got 0.5"),
    );
  });

  it("a cursor this store never gave is a RangeError saying to pass a page's next", () => {
    expect(seqOfCursor("12")).toBe(12);
    for (const cursor of ["0", "012", "-1", "1.5", "x", "9007199254740993"])
      expect(() => seqOfCursor(cursor)).toThrow(
        new RangeError("the cursor is not one this store gave: pass the next of one of its pages"),
      );
  });
});
