/**
 * The retention's look for removable pauses as the client sends it (a fake collection, no server): the
 * closed pauses before the cut-off, in insertion order after the cursor, a batch at a time.
 */
import { PauseStatus } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { Collections } from "../../src/index.js";
import { removableBefore } from "../../src/stores/paused/pause-scans.js";

const CUTOFF = new Date("2026-01-05T09:00:00.000Z");
const SESSION = { id: "session" } as never;

describe("removableBefore", () => {
  it("finds the closed pauses resolved before the cut-off, oldest sequence first, a batch of the limit", async () => {
    const log: unknown[][] = [];
    const cursor = {
      sort: (sort: unknown) => {
        log.push(["sort", sort]);
        return cursor;
      },
      limit: (limit: unknown) => {
        log.push(["limit", limit]);
        return cursor;
      },
      toArray: () => Promise.resolve([]),
    };
    const db = {
      collection: (name: string) => ({
        find: (...args: unknown[]) => {
          log.push([name, "find", ...args]);
          return cursor;
        },
      }),
    } as never;

    expect(await removableBefore(db, CUTOFF, 25, SESSION, "7")).toStrictEqual([]);

    expect(log).toStrictEqual([
      [
        Collections.Pauses,
        "find",
        {
          status: { $in: [PauseStatus.Taken, PauseStatus.Cancelled] },
          resolvedAt: { $lt: CUTOFF },
          seq: { $gt: 7 },
        },
        { session: SESSION },
      ],
      ["sort", { seq: 1 }],
      ["limit", 25],
    ]);
  });
});
