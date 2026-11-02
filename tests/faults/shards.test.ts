import { FAULT_SCENARIOS } from "@agboss/core/testing/faults";
import { describe, expect, it } from "vitest";
import { faultShardOf, scenariosOf } from "./mongodb-target.js";

/**
 * agbossjs/agboss#607 — CI runs the fault suite on the real clock in shards (`AGBOSS_FAULT_SHARD`):
 * every scenario in exactly one shard, a malformed shard refused rather than running nothing.
 */
describe("agbossjs/agboss#607: the fault suite's shards", () => {
  it("cover every scenario exactly once, for any number of shards", () => {
    for (const count of [1, 2, 3, 5, FAULT_SCENARIOS.length + 1]) {
      const ids = Array.from({ length: count }, (_, at) =>
        scenariosOf({ index: at + 1, count }),
      ).flatMap((each) => each ?? []);
      expect([...ids].sort()).toEqual(FAULT_SCENARIOS.map((scenario) => scenario.id).sort());
    }
  });

  it("no shard runs every scenario; a malformed one is refused", () => {
    expect(faultShardOf(undefined)).toBeUndefined();
    expect(faultShardOf("")).toBeUndefined();
    expect(scenariosOf(undefined)).toBeUndefined();
    expect(faultShardOf("2/3")).toEqual({ index: 2, count: 3 });
    for (const text of ["0/3", "4/3", "1/0", "3", "1/3/1", " 1/3", "a/b", "-1/3"])
      expect(() => faultShardOf(text)).toThrow(RangeError);
  });
});
