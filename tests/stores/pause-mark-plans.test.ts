/**
 * agbossjs/agboss#1213: the plans of the sent mark (`pause-marks.ts`) and of a reassignment
 * (`reassignChange`, to a replacement or in place).
 */
import { PauseResolution, PauseStatus, type PauseRecord } from "@agboss/core";
import { PauseNoticeKind, type PauseRecipients } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import { markSentChange } from "../../src/stores/paused/pause-marks.js";
import { reassignChange } from "../../src/stores/paused/pause-reassign-plan.js";
import { ANSWER, NINE, pauseOf } from "../support/pauses.js";

const AUDIT: PauseRecipients = { listeners: ["audit"] };
const AT = new Date("2026-01-05T10:00:00.000Z");
const LATER = "2026-01-05T11:00:00.000Z";
const EARLIER = "2026-01-05T09:30:00.000Z";

describe("agbossjs/agboss#1213: the sent mark's plan", () => {
  it("a pause already sent changes nothing and writes no notice", () => {
    const sent = { ...pauseOf("p"), isSent: true };

    expect(markSentChange(sent, AUDIT)).toStrictEqual({ pause: sent, notices: [] });
  });

  it("a pending pause's opened notice is due when it was asked, and names its deadline only when it has one", () => {
    const opened = (pause: PauseRecord) => markSentChange(pause, AUDIT).notices;

    expect(opened(pauseOf("p"))).toStrictEqual([
      {
        recipient: "listener:audit",
        at: NINE,
        notice: { kind: PauseNoticeKind.Opened, writtenAt: NINE.toISOString() },
      },
    ]);
    expect(opened({ ...pauseOf("p"), expiresAt: LATER })[0]?.notice).toStrictEqual({
      kind: PauseNoticeKind.Opened,
      writtenAt: NINE.toISOString(),
      expiresAt: LATER,
    });
  });

  it("a record with no usable asked time is asked at the epoch", () => {
    for (const askedAt of ["", "not a time"]) {
      const [notice] = markSentChange({ ...pauseOf("p"), askedAt }, AUDIT).notices;

      expect(notice?.at).toStrictEqual(new Date(0));
      expect(notice?.notice.writtenAt).toBe("1970-01-01T00:00:00.000Z");
    }
  });

  const closed = (fields: Partial<PauseRecord>): PauseNoticeKind[] =>
    markSentChange(
      { ...pauseOf("p"), resolvedAt: EARLIER, status: PauseStatus.Cancelled, ...fields },
      AUDIT,
    ).notices.map((one) => one.notice.kind);
  const OPENED_CLOSED = [PauseNoticeKind.Opened, PauseNoticeKind.Closed];
  const UNTAKEN = [...OPENED_CLOSED, PauseNoticeKind.AnswerNotTaken];

  it.each([
    ["an answer closed untaken by a cancel", PauseResolution.Cancelled, ANSWER, UNTAKEN],
    ["an answer closed untaken by a tree end", PauseResolution.TreeEnded, ANSWER, UNTAKEN],
    ["an answer a step took", PauseResolution.Replied, ANSWER, OPENED_CLOSED],
    ["a cancel with no answer", PauseResolution.Cancelled, undefined, OPENED_CLOSED],
    ["a tree end with no answer", PauseResolution.TreeEnded, undefined, OPENED_CLOSED],
  ])("a pause closed before it was sent: %s", (_name, resolution, answer, kinds) => {
    expect(closed({ resolution, answer })).toEqual(kinds);
  });
});

describe("agbossjs/agboss#1213: a reassignment's plan", () => {
  const plan = (before: PauseRecord) =>
    reassignChange(before, { pauseId: "p-r", assignees: ["alice"] }, new Set(), AT, AUDIT);

  it.each([
    ["no deadline", {}],
    ["a deadline after `at`", { expiresAt: LATER }],
  ])("a pending pause with %s is reassigned, its replacement unsent", (_name, fields) => {
    const change = plan({ ...pauseOf("p"), ...fields });

    expect(change?.pause).toMatchObject({ status: "cancelled", reassignedTo: "p-r" });
    expect(change?.inserted).toMatchObject({
      pauseId: "p-r",
      status: PauseStatus.Pending,
      isSent: false,
      reassignedFrom: "p",
      stepKey: "run-1:p:1~r1",
    });
  });

  it.each([
    ["a deadline at `at`", { expiresAt: AT.toISOString() }],
    ["a deadline before `at`", { expiresAt: EARLIER }],
    ["a resolved pause with no deadline", { status: PauseStatus.Resolved }],
    [
      "a resolved pause with a deadline to come",
      { status: PauseStatus.Resolved, expiresAt: LATER },
    ],
    ["a cancelled pause", { status: PauseStatus.Cancelled }],
  ])("%s is not reassigned", (_name, fields) => {
    expect(plan({ ...pauseOf("p"), ...fields })).toBeUndefined();
  });
});

describe("agbossjs/agboss#1307: a reassignment in place", () => {
  const inPlace = (before: PauseRecord, change: Record<string, unknown>) =>
    reassignChange(before, { assignees: ["alice"], ...change }, new Set(), AT, AUDIT);

  it("keeps the pause: its id, status and step key stay, a `reassigned` entry is added, no replacement is made", () => {
    const before = { ...pauseOf("p"), isSent: true };

    const change = inPlace(before, { actor: { id: "boss" }, reason: "on leave" });

    expect(change?.inserted).toBeUndefined();
    expect(change?.pause).toMatchObject({
      pauseId: "p",
      status: PauseStatus.Pending,
      stepKey: before.stepKey,
      assignees: ["alice"],
    });
    expect(change?.pause.trail.at(-1)).toMatchObject({
      action: "reassigned",
      actor: { id: "boss" },
      reason: "on leave",
      assignees: ["alice"],
    });
    expect(change?.notices.map((one) => one.notice.kind)).toEqual([PauseNoticeKind.Reassigned]);
  });

  it("an unsent pause tells nobody", () => {
    expect(inPlace(pauseOf("p"), {})?.notices).toEqual([]);
  });

  it("is refused at `maxReassignments`, and when the pause is not as it was seen", () => {
    const once = inPlace(pauseOf("p"), {})?.pause;
    if (once === undefined) throw new Error("the first reassignment applies");

    expect(inPlace(once, { maxReassignments: 1 })).toBeUndefined();
    expect(inPlace(once, { maxReassignments: 2 })).toBeDefined();
    expect(inPlace(once, { seen: { trailLength: 1 } })).toBeUndefined();
    expect(inPlace(once, { seen: { trailLength: 2, assignees: ["alice"] } })).toBeDefined();
  });

  it("an expiry's reassignment (`due`) applies only to a pause whose deadline is over, and sets the new deadline", () => {
    const due = { expiresAt: "2026-01-05T12:00:00.000Z" };

    expect(inPlace({ ...pauseOf("p"), expiresAt: LATER }, { due })).toBeUndefined();
    expect(inPlace({ ...pauseOf("p"), expiresAt: EARLIER }, { due })?.pause.expiresAt).toBe(
      due.expiresAt,
    );
  });
});
