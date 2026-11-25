/**
 * agbossjs/agboss#1213: the pause scans' limits, cursors and pages — each bound and each refusal
 * exactly, and the order of a page the order of the sequence (or of the scan's key), never the order
 * the rows were stored in.
 */
import { PauseStatus } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { MongoPausedExecutionRepository } from "../../src/index.js";
import {
  assertPauseFilter,
  assertScanLimit,
  removableBefore,
  seqOfCursor,
  tenantFilter,
} from "../../src/stores/paused/pause-scans.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { NINE } from "../support/pauses.js";
import { insertMailboxRow, insertPauseRow, insertTakenRow } from "../support/pause-rows.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();
const LATER = new Date(NINE.getTime() + 60_000);

beforeEach(() => emptyAll(database.url()));

const storeOn = () =>
  new MongoPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());
const dbOf = () => connectionTo(database.url()).db;
const idsOf = (pauses: readonly { readonly pauseId: string }[]): string[] =>
  pauses.map((one) => one.pauseId);

describe("agbossjs/agboss#1213: the limit, the filter and the cursor", () => {
  it.each([0, -1, 1.5, Number.NaN, 1001])("a limit of %s is refused, by its number", (limit) => {
    expect(() => {
      assertScanLimit(limit);
    }).toThrowError(
      new RangeError(`a pause scan's limit is a whole number from 1 to 1000, not ${String(limit)}`),
    );
  });

  it("a limit of 1 and of 1000 is taken", () => {
    expect(() => {
      assertScanLimit(1);
      assertScanLimit(1000);
    }).not.toThrow();
  });

  it("a filter that names no status is refused", () => {
    expect(() => {
      assertPauseFilter({ statuses: [] });
    }).toThrowError(new TypeError("a pause filter names at least one status"));
  });

  it.each(["1e3", " 12", "12 ", "0x10", "-5", "abc", "", "1.5", "99999999999999999999"])(
    "the cursor %j is no cursor: it is refused by its text",
    (cursor) => {
      expect(() => seqOfCursor(cursor)).toThrowError(
        new TypeError(`${JSON.stringify(cursor)} is not a pause page cursor`),
      );
    },
  );

  it("a cursor is the sequence it names; none is the start", () => {
    expect(seqOfCursor("12")).toBe(12);
    expect(seqOfCursor("0")).toBe(0);
    expect(seqOfCursor(undefined)).toBe(0);
  });

  it("a tenant's filter names a target and a deadline only when asked", () => {
    const statuses = [PauseStatus.Pending];

    expect(tenantFilter("t", { statuses })).toStrictEqual({
      tenantId: "t",
      status: { $in: statuses },
    });
    expect(tenantFilter("t", { statuses, target: "refund-tool-approval" })).toStrictEqual({
      tenantId: "t",
      status: { $in: statuses },
      target: "refund-tool-approval",
    });
  });

  it("a scan's keyset with an unreadable time is refused by its text", async () => {
    const after = { at: "nonsense", tenantId: "default", pauseId: "p" };

    await expect(storeOn().findPendingByExpiresAtBefore(LATER, 5, after)).rejects.toThrowError(
      new TypeError(`a pause scan's cursor is an ISO 8601 time, not "nonsense"`),
    );
  });

  it("the scans that are not paged refuse a limit too", async () => {
    const message = (limit: number) =>
      new RangeError(`a pause scan's limit is a whole number from 1 to 1000, not ${String(limit)}`);

    await expect(storeOn().findPendingUnsentReassignedBefore(LATER, 0)).rejects.toThrowError(
      message(0),
    );
    await expect(
      storeOn().findPageByTenantId("default", { statuses: [PauseStatus.Pending] }, 0),
    ).rejects.toThrowError(message(0));
    await expect(
      storeOn().setAsideStaleNoticesBefore(LATER, LATER, "stale", 0),
    ).rejects.toThrowError(message(0));
    await expect(storeOn().findClosedByResolvedAtBefore(LATER, 1001)).rejects.toThrowError(
      message(1001),
    );
  });
});

describe("agbossjs/agboss#1213: a page is in the sequence's order, its cursor the last it holds", () => {
  /** Five open pauses stored a, b, c, d, e with the sequences 30, 10, 20, 40, 50. */
  async function openRows(): Promise<void> {
    for (const [id, seq] of [
      ["a", 30],
      ["b", 10],
      ["c", 20],
      ["d", 40],
      ["e", 50],
    ] as const)
      await insertPauseRow(dbOf(), id, seq);
  }

  it("the open pauses: a page of three ends at the third's sequence, the rest follows, the last has no cursor", async () => {
    await openRows();
    const store = storeOn();

    const first = await store.findOpenAfter(undefined, 3);
    const second = await store.findOpenAfter(first.next, 3);

    expect(idsOf(first.pauses)).toEqual(["b", "c", "a"]);
    expect(first.next).toBe("30");
    expect(idsOf(second.pauses)).toEqual(["d", "e"]);
    expect(second).not.toHaveProperty("next");
  });

  it("a page that holds exactly what is left has no cursor", async () => {
    await openRows();

    const page = await storeOn().findOpenAfter("30", 2);

    expect(idsOf(page.pauses)).toEqual(["d", "e"]);
    expect(page).not.toHaveProperty("next");
  });

  it("the closed pauses a delete would remove: in the sequence's order, the same cursors", async () => {
    for (const [id, seq] of [
      ["a", 30],
      ["b", 10],
      ["c", 20],
      ["d", 40],
    ] as const)
      await insertTakenRow(dbOf(), id, seq, NINE.toISOString());
    const store = storeOn();

    const first = await store.findClosedByResolvedAtBefore(LATER, 3);
    const rest = await store.findClosedByResolvedAtBefore(LATER, 3, first.next);
    const exact = await store.findClosedByResolvedAtBefore(LATER, 1, "30");

    expect(idsOf(first.pauses)).toEqual(["b", "c", "a"]);
    expect(first.next).toBe("30");
    expect(idsOf(rest.pauses)).toEqual(["d"]);
    expect(rest).not.toHaveProperty("next");
    expect(idsOf(exact.pauses)).toEqual(["d"]);
    expect(exact).not.toHaveProperty("next");
  });

  it("removable pauses are read at most `limit` of them, even when a first batch was mostly kept", async () => {
    const db = dbOf();
    for (const [id, seq] of [
      ["k1", 1],
      ["k2", 2],
      ["r1", 3],
      ["r2", 4],
      ["r3", 5],
      ["r4", 6],
    ] as const)
      await insertTakenRow(db, id, seq, NINE.toISOString());
    for (const id of ["k1", "k2"])
      await insertMailboxRow(db, id, { headWrittenAt: NINE, nextAttemptAt: NINE });

    const removable = await removableBefore(db, LATER, 3);

    expect(idsOf(removable)).toEqual(["r1", "r2", "r3"]);
  });

  it("a pause is kept for a replacement it names, not for a pause called undefined", async () => {
    const db = dbOf();
    await insertTakenRow(db, "plain", 1, NINE.toISOString());
    await insertPauseRow(db, "undefined", 2);

    const page = await storeOn().findClosedByResolvedAtBefore(LATER, 5);

    expect(idsOf(page.pauses)).toEqual(["plain"]);
  });

  it("the re-send scan is in the order of the time asked, not of the storing", async () => {
    const db = dbOf();
    const asked = (minutes: number) => new Date(NINE.getTime() - minutes * 60_000);
    for (const [id, minutes] of [
      ["late", 1],
      ["early", 30],
      ["middle", 10],
    ] as const)
      await insertPauseRow(
        db,
        id,
        1,
        { reassignedFrom: "old", askedAt: asked(minutes).toISOString() },
        { reassignedFrom: "old", askedAt: asked(minutes) },
      );

    const found = await storeOn().findPendingUnsentReassignedBefore(LATER, 10);

    expect(idsOf(found)).toEqual(["early", "middle", "late"]);
  });
});
