/**
 * agbossjs/agboss#1213: the plans of the sent mark (`pause-marks.ts`) and of a reassignment
 * (`reassignChange`, to a replacement or in place).
 */
import { PauseResolution, PauseStatus, type PauseRecord } from "@agboss/core";
import { PauseRespondent } from "@agboss/core/stores";
import { PauseNoticeKind, seenOf, type PauseRecipients } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import { markSentChange } from "../../src/stores/paused/pause-marks.js";
import { reassignChange } from "../../src/stores/paused/pause-reassign-plan.js";
import { ANSWER, NINE, openedEntryOf, pauseOf } from "../support/pauses.js";

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
    reassignChange(
      before,
      { pauseId: "p-r", assignees: ["alice"], seen: seenOf(before) },
      new Set(),
      AT,
      AUDIT,
    );

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
    reassignChange(
      before,
      { assignees: ["alice"], seen: seenOf(before), ...change },
      new Set(),
      AT,
      AUDIT,
    );

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

  it("a change with no `seen` applies to nothing, and one planned over another state is refused", () => {
    const before = pauseOf("p");
    const bare = { assignees: ["alice"] } as never;

    expect(reassignChange(before, bare, new Set(), AT, AUDIT)).toBeUndefined();
    expect(inPlace(before, { seen: { ...seenOf(before), trailLength: 2 } })).toBeUndefined();
    expect(inPlace(before, { seen: { ...seenOf(before), isSent: true } })).toBeUndefined();
    expect(inPlace(before, { seen: { ...seenOf(before), assignees: ["bob"] } })).toBeUndefined();
    expect(inPlace(before, { seen: seenOf(before) })).toBeDefined();
  });

  it("is refused at the record's own maxReassignments, never the change's", () => {
    const limited = { ...pauseOf("p"), escalationLimits: { maxReassignments: 1 } };
    const once = inPlace(limited, {})?.pause;
    if (once === undefined) throw new Error("the first reassignment applies");

    expect(inPlace(once, {})).toBeUndefined();
    expect(inPlace({ ...once, escalationLimits: { maxReassignments: 2 } }, {})).toBeDefined();
    expect(inPlace(pauseOf("p"), {})?.pause.escalationLimits).toEqual({});
  });

  it("a deadline it sets counts as an extension against the record's maxExtensions, and is kept to the cap", () => {
    const timeout = { expiresAt: "2026-01-05T12:00:00.000Z" };
    const limited = { ...pauseOf("p"), escalationLimits: { maxExtensions: 1 } };
    const spent = inPlace(limited, { timeout, countsAsExtension: true })?.pause;
    if (spent === undefined) throw new Error("the first extension applies");

    expect(spent.trail.map((entry) => entry.action)).toEqual([
      "opened",
      "reassigned",
      "timeout-changed",
    ]);
    expect(inPlace(spent, { timeout, countsAsExtension: true })).toBeUndefined();
    expect(inPlace(spent, { timeout })).toBeDefined();
    const capped = { ...pauseOf("p"), maxExpiresAt: "2026-01-05T11:00:00.000Z" };
    expect(inPlace(capped, { timeout })).toBeUndefined();
    expect(inPlace(capped, { timeout: { expiresAt: LATER } })).toBeDefined();
    // a cap and a change that sets no deadline: it does not touch the cap
    expect(inPlace(capped, {})).toBeDefined();
    expect(inPlace(capped, { timeout: {} })).toBeUndefined();
  });

  it("an expiry's reassignment (`due`) applies only to a pause whose deadline is over, and sets the new deadline", () => {
    const due = { expiresAt: "2026-01-05T12:00:00.000Z" };

    expect(inPlace({ ...pauseOf("p"), expiresAt: LATER }, { due })).toBeUndefined();
    expect(inPlace({ ...pauseOf("p"), expiresAt: EARLIER }, { due })?.pause.expiresAt).toBe(
      due.expiresAt,
    );
  });
});

describe("agbossjs/agboss#1307, Q-D: the replacement's limits are narrowed over the record read", () => {
  const TO = { target: "other-target", respondent: PauseRespondent.Delegate, channel: "other" };
  const limited: PauseRecord = {
    ...pauseOf("p"),
    maxExpiresAt: "2026-01-05T18:00:00.000Z",
    escalationLimits: { maxExtensions: 4, maxReassignments: 3 },
  };
  const move = (before: PauseRecord, to: Record<string, unknown>, change = {}) =>
    reassignChange(
      before,
      { pauseId: "p-r", seen: seenOf(before), to: { ...TO, ...to }, ...change },
      new Set(),
      AT,
      AUDIT,
    );

  it("the smaller of the record's and the offer's, per field; looser offers loosen nothing", () => {
    const tighter = move(limited, {
      limits: {
        maxExpiresAt: "2026-01-05T15:00:00.000Z",
        escalationLimits: { maxExtensions: 9, maxReassignments: 2 },
      },
    })?.inserted;

    expect(tighter).toMatchObject({
      firstAskedAt: limited.firstAskedAt,
      maxExpiresAt: "2026-01-05T15:00:00.000Z",
      escalationLimits: { maxExtensions: 4, maxReassignments: 2 },
    });
    expect(
      move(limited, { limits: { maxExpiresAt: "2026-01-06T00:00:00.000Z" } })?.inserted,
    ).toMatchObject({ maxExpiresAt: "2026-01-05T18:00:00.000Z" });
    expect(move(limited, {})?.inserted).toMatchObject({
      maxExpiresAt: "2026-01-05T18:00:00.000Z",
      escalationLimits: { maxExtensions: 4, maxReassignments: 3 },
    });
  });

  it("a pause with no limits takes the destination's; none stays absent, never null", () => {
    const taken = move(pauseOf("p"), {
      limits: { maxExpiresAt: LATER, escalationLimits: { maxReassignments: 5 } },
    })?.inserted;
    const none = move(pauseOf("p"), {})?.inserted;

    expect(taken).toMatchObject({ maxExpiresAt: LATER, escalationLimits: { maxReassignments: 5 } });
    expect(Object.keys(none ?? {})).not.toContain("maxExpiresAt");
    expect(none?.escalationLimits).toStrictEqual({});
  });

  it("the destination's reassignment count applies at once: a chain that holds that many is refused", () => {
    const chained = {
      ...pauseOf("p"),
      trail: [
        ...pauseOf("p").trail,
        { ...openedEntryOf(pauseOf("p")), action: "reassigned" as const },
      ],
    };
    const offer = (maxReassignments: number) => ({
      limits: { escalationLimits: { maxReassignments } },
    });

    expect(move(chained, offer(1))).toBeUndefined();
    expect(move(chained, offer(2))?.inserted).toMatchObject({
      escalationLimits: { maxReassignments: 2 },
    });
  });

  it("a move that sets a deadline spends an extension of the narrowed count, and the cap judges its deadline", () => {
    const timeout = { expiresAt: "2026-01-05T12:00:00.000Z" };
    const spent = move(
      limited,
      { limits: { escalationLimits: { maxExtensions: 1 } } },
      { timeout, countsAsExtension: true },
    )?.inserted;

    expect(spent?.escalationLimits).toEqual({ maxExtensions: 1, maxReassignments: 3 });
    expect(spent?.trail.map((entry) => entry.action)).toEqual([
      "opened",
      "reassigned",
      "timeout-changed",
    ]);
    const none = { limits: { escalationLimits: { maxExtensions: 0 } } };
    expect(move(limited, none, { timeout, countsAsExtension: true })).toBeUndefined();
    const late = { expiresAt: "2026-01-05T19:00:00.000Z" };
    expect(move(limited, {}, { timeout: late })).toBeUndefined();
    // the offer's tighter cap narrows what the move itself may set
    expect(
      move(limited, { limits: { maxExpiresAt: "2026-01-05T11:00:00.000Z" } }, { timeout }),
    ).toBeUndefined();
  });

  it("the replacement carries no `limits` of the destination's offer in its own record", () => {
    const made = move(limited, { limits: { escalationLimits: { maxExtensions: 1 } } })?.inserted;

    expect(JSON.stringify(made)).not.toContain('"limits"');
  });
});

describe("agbossjs/agboss#1307: a pause changed in place while its first send ran", () => {
  /** Asked at nine with `EARLIER` as its deadline (its `opened` entry says so). */
  const asked = (): PauseRecord => {
    const base = pauseOf("p");
    const [, ...rest] = base.trail;
    return {
      ...base,
      expiresAt: EARLIER,
      trail: [{ ...openedEntryOf(base), expiresAt: EARLIER }, ...rest],
    };
  };

  it("`opened` names the deadline the channel was asked with, then `reassigned` tells what changed, due at the change", () => {
    const base = asked();
    const during = reassignChange(
      base,
      { assignees: ["alice"], seen: seenOf(base), due: { expiresAt: LATER } },
      new Set(),
      AT,
      AUDIT,
    );
    if (during === undefined) throw new Error("the change applies");

    const { notices, pause } = markSentChange(during.pause, AUDIT, "JIRA-1");

    expect(pause.isSent).toBe(true);
    expect(notices.map((one) => one.notice.kind)).toEqual([
      PauseNoticeKind.Opened,
      PauseNoticeKind.Reassigned,
    ]);
    expect(notices[0]?.notice).toStrictEqual({
      kind: PauseNoticeKind.Opened,
      writtenAt: NINE.toISOString(),
      expiresAt: EARLIER,
    });
    expect(notices[1]).toStrictEqual({
      recipient: "listener:audit",
      at: AT,
      notice: {
        kind: PauseNoticeKind.Reassigned,
        writtenAt: AT.toISOString(),
        expiresAt: LATER,
        previousExpiresAt: EARLIER,
        assignees: ["alice"],
        previousTarget: "refund-tool-approval",
        previousChannel: "refund-approval-channel",
      },
    });
  });

  it("a pause never changed, and a replacement, tell no `reassigned` of this kind", () => {
    expect(markSentChange(pauseOf("p"), AUDIT).notices.map((one) => one.notice.kind)).toEqual([
      PauseNoticeKind.Opened,
    ]);
    const replacement = reassignChange(
      pauseOf("p"),
      { pauseId: "p-r", seen: seenOf(pauseOf("p")) },
      new Set(),
      AT,
      AUDIT,
    )?.inserted;
    if (replacement === undefined) throw new Error("the move applies");
    expect(markSentChange(replacement, AUDIT).notices.map((one) => one.notice.kind)).toEqual([
      PauseNoticeKind.Reassigned,
    ]);
  });
});
