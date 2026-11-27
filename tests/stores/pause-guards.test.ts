/**
 * The filters of the pause store's conditional writes (`pause-guards.ts`), the second line behind the
 * core's pure transitions: they are decided over the record read in the same snapshot transaction, and a
 * concurrent writer is a write conflict; the filters say, in the write itself, what that decision rests on.
 */
import { PauseStatus } from "@agboss/core";
import { describe, expect, it } from "vitest";
import {
  changeableAt,
  dueAt,
  inStatus,
  openAt,
  PAUSE_GUARDS,
  remindableAt,
} from "../../src/stores/paused/pause-guards.js";

const AT = new Date("2026-01-05T09:00:00.000Z");
const PREVIOUS = new Date("2026-01-05T10:00:00.000Z");

describe("the pause guards", () => {
  it("open: pending, with no deadline or one after the moment", () => {
    expect(openAt(AT)).toStrictEqual({
      status: PauseStatus.Pending,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: AT } }],
    });
  });

  it("due: pending, the deadline at or before the moment", () => {
    expect(dueAt(AT)).toStrictEqual({ status: PauseStatus.Pending, expiresAt: { $lte: AT } });
  });

  it("changeable: over the deadline the caller read, which is after the moment; none read: none stored", () => {
    expect(changeableAt(AT, PREVIOUS)).toStrictEqual({
      status: PauseStatus.Pending,
      $and: [{ expiresAt: { $eq: PREVIOUS } }, { expiresAt: { $gt: AT } }],
    });
    expect(changeableAt(AT, undefined)).toStrictEqual({
      status: PauseStatus.Pending,
      expiresAt: null,
    });
  });

  it("remindable: a reminder due and a deadline after the moment", () => {
    expect(remindableAt(AT)).toStrictEqual({
      status: PauseStatus.Pending,
      expiresAt: { $gt: AT },
      remindAt: { $lte: AT },
    });
  });

  it("in status: the status alone", () => {
    expect(inStatus(PauseStatus.Resolved)).toStrictEqual({ status: PauseStatus.Resolved });
  });

  it("the store's guards are these five", () => {
    expect(PAUSE_GUARDS).toStrictEqual({
      open: openAt,
      due: dueAt,
      changeable: changeableAt,
      remindable: remindableAt,
      inStatus,
    });
  });
});
