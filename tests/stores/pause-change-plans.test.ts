/**
 * agbossjs/agboss#1213: the pure plans of every pause transition (`pause-changes.ts`) — the record
 * a change makes and the notices written with it — read field by field, an absent field absent
 * (`toStrictEqual`), never `undefined`.
 */
import {
  ExpiryProblem,
  PauseClosedReason,
  PauseResolution,
  PauseStatus,
  type PauseRecord,
} from "@agboss/core";
import {
  PauseExpiryBound,
  PauseNoticeKind,
  seenOf,
  type PauseRecipients,
} from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import {
  cancelChange,
  closeUntakenChange,
  closedNotices,
  decideChange,
  expireChange,
  remindChange,
  resolveChange,
} from "../../src/stores/paused/pause-changes.js";
import { timeoutChange } from "../../src/stores/paused/pause-timeout.js";
import { openedEntryOf, pauseOf } from "../support/pauses.js";

const AUDIT: PauseRecipients = { listeners: ["audit"] };
const AT = new Date("2026-01-05T10:00:00.000Z");
const LATER = "2026-01-05T11:00:00.000Z";
const EARLIER = "2026-01-05T09:30:00.000Z";

const sent = (fields: Partial<PauseRecord> = {}): PauseRecord => ({
  ...pauseOf("p"),
  isSent: true,
  ...fields,
});

const keysOf = (pause: PauseRecord): string[] => Object.keys(pause);

describe("agbossjs/agboss#1213: the closed notice", () => {
  it("a record that did not close has no closed notice: it is refused by its id", () => {
    expect(() => closedNotices(sent(), AT, AUDIT)).toThrowError(
      new TypeError("pause p did not close"),
    );
  });

  it("a notice of a close with no time carries no closedAt, not an undefined one", () => {
    const expired = sent({ status: PauseStatus.Cancelled, resolution: PauseResolution.Expired });

    expect(closedNotices(expired, AT, AUDIT)).toStrictEqual([
      {
        recipient: "listener:audit",
        at: AT,
        notice: {
          kind: PauseNoticeKind.Closed,
          writtenAt: AT.toISOString(),
          reason: PauseClosedReason.Expired,
        },
      },
    ]);
  });
});

describe("agbossjs/agboss#1213: a cancel", () => {
  const cancelled = (before: PauseRecord, resolution: PauseResolution.Cancelled) =>
    cancelChange(before, resolution, AT, AUDIT).pause.resolution;

  it("a pause with no deadline is cancelled, not expired", () => {
    expect(cancelled(sent(), PauseResolution.Cancelled)).toBe(PauseResolution.Cancelled);
  });

  it("a deadline over (at, or before it) records an expiry, except for a withdrawal; one to come does not", () => {
    expect(cancelled(sent({ expiresAt: AT.toISOString() }), PauseResolution.Cancelled)).toBe(
      PauseResolution.Expired,
    );
    expect(cancelled(sent({ expiresAt: LATER }), PauseResolution.Cancelled)).toBe(
      PauseResolution.Cancelled,
    );
    const withdrawn = cancelChange(
      sent({ expiresAt: EARLIER }),
      PauseResolution.Withdrawn,
      AT,
      AUDIT,
    );
    expect(withdrawn.pause.resolution).toBe(PauseResolution.Withdrawn);
  });
});

describe("agbossjs/agboss#1213: an expiry", () => {
  it("without a problem the record has no expiryProblem; with one, it is kept", () => {
    const plain = expireChange(sent({ expiresAt: EARLIER }), {}, AT, AUDIT).pause;
    const failed = expireChange(
      sent({ expiresAt: EARLIER }),
      { problem: ExpiryProblem.HandlerFailed },
      AT,
      AUDIT,
    ).pause;

    expect(keysOf(plain)).not.toContain("expiryProblem");
    expect(plain).toMatchObject({ status: "cancelled", resolution: PauseResolution.Expired });
    expect(failed.expiryProblem).toBe(ExpiryProblem.HandlerFailed);
  });
});

describe("agbossjs/agboss#1213: closing an answer no step took", () => {
  const untaken = (before: Partial<PauseRecord>): PauseRecord =>
    closeUntakenChange(
      sent({ status: PauseStatus.Resolved, ...before }),
      PauseResolution.Cancelled,
      AT,
      AUDIT,
    ).pause;
  const first = { resolution: PauseResolution.Replied, resolvedAt: EARLIER };

  it("the first close is kept as closedFirst when its resolution and time are both known", () => {
    expect(untaken(first).closedFirst).toStrictEqual({
      resolution: PauseResolution.Replied,
      resolvedAt: EARLIER,
    });
  });

  it.each([
    ["no resolution", { resolvedAt: EARLIER }],
    ["no time", { resolution: PauseResolution.Replied }],
    ["neither", {}],
  ])("a first close with %s leaves no closedFirst", (_name, before) => {
    expect(keysOf(untaken(before))).not.toContain("closedFirst");
  });
});

describe("agbossjs/agboss#1307: a deadline change", () => {
  const change = (before: PauseRecord, expiresAt: string | undefined, fields = {}) =>
    timeoutChange(
      before,
      {
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(before.expiresAt === undefined ? {} : { previousExpiresAt: before.expiresAt }),
        seen: seenOf(before),
        ...fields,
      },
      AT,
      AUDIT,
    );

  it("a pause with no deadline takes one (set over none), and one is taken away (to none)", () => {
    const set = change(sent(), LATER);
    expect(set?.pause).toMatchObject({ expiresAt: LATER });
    const taken = change(sent({ expiresAt: LATER }), undefined);
    expect(taken?.pause.expiresAt).toBeUndefined();
    expect(keysOf(taken?.pause ?? sent())).toContain("trail");
  });

  it("a new deadline at or before `at` is refused; one after it is made, earlier or later than before", () => {
    const before = sent({ expiresAt: LATER });

    expect(change(before, AT.toISOString())).toBeUndefined();
    expect(change(before, "2026-01-05T09:59:59.000Z")).toBeUndefined();
    expect(change(before, "2026-01-05T10:30:00.000Z")?.pause).toMatchObject({
      expiresAt: "2026-01-05T10:30:00.000Z",
    });
    expect(change(before, "2026-01-05T12:00:00.000Z")?.pause).toMatchObject({
      expiresAt: "2026-01-05T12:00:00.000Z",
    });
  });

  it("only from the deadline the caller read: a stale previousExpiresAt, absent or not, is refused", () => {
    const before = sent({ expiresAt: LATER });

    expect(
      change(before, "2026-01-05T12:00:00.000Z", { previousExpiresAt: EARLIER }),
    ).toBeUndefined();
    expect(
      change(before, "2026-01-05T12:00:00.000Z", { previousExpiresAt: undefined }),
    ).toBeUndefined();
    expect(
      timeoutChange(
        sent(),
        { expiresAt: LATER, previousExpiresAt: EARLIER, seen: seenOf(sent()) },
        AT,
        AUDIT,
      ),
    ).toBeUndefined();
  });

  it("only while the pause is as it was read (#1419 H1): another trail, assignees or sent state is refused", () => {
    const before = sent({ expiresAt: LATER });
    const seen = seenOf(before);
    const moved = (fields: Partial<PauseRecord>) =>
      timeoutChange(
        { ...before, ...fields },
        { expiresAt: "2026-01-05T12:00:00.000Z", previousExpiresAt: LATER, seen },
        AT,
        AUDIT,
      );

    expect(moved({})).toBeDefined();
    expect(moved({ assignees: ["deputy-3"] })).toBeUndefined();
    expect(moved({ isSent: false })).toBeUndefined();
    expect(moved({ trail: [...before.trail, openedEntryOf(before)] })).toBeUndefined();
  });

  it("the record's own cap and count judge it: past maxExpiresAt, none while a cap is set, a chain that holds maxExtensions", () => {
    const capped = sent({ expiresAt: EARLIER, maxExpiresAt: LATER });
    expect(change(capped, LATER)?.pause).toMatchObject({ expiresAt: LATER });
    expect(change(capped, "2026-01-05T11:00:00.001Z")).toBeUndefined();
    expect(change(capped, undefined)).toBeUndefined();
    const once = sent({
      expiresAt: LATER,
      escalationLimits: { maxExtensions: 1 },
      trail: [...pauseOf("p").trail, { ...openedEntryOf(pauseOf("p")), action: "timeout-changed" }],
    });
    expect(change(once, "2026-01-05T12:00:00.000Z")).toBeUndefined();
    expect(
      change({ ...once, escalationLimits: { maxExtensions: 2 } }, "2026-01-05T12:00:00.000Z"),
    ).toBeDefined();
  });

  it("the chain entry names the actor and the reason, and takes the deadline only when there is one", () => {
    const set = change(sent(), LATER, { actor: { id: "ops-1" }, reason: "customer asked" });
    const taken = change(sent({ expiresAt: LATER }), undefined);

    expect(set?.pause.trail.at(-1)).toStrictEqual({
      action: "timeout-changed",
      at: AT.toISOString(),
      actor: { id: "ops-1" },
      target: "refund-tool-approval",
      channel: "refund-approval-channel",
      expiresAt: LATER,
      reason: "customer asked",
    });
    expect(keysOf(taken?.pause.trail.at(-1) as never)).not.toContain("expiresAt");
  });

  it("its notice names the new and the previous deadline, each only when there is one, with the change's own actor and reason", () => {
    expect(
      change(sent({ expiresAt: EARLIER }), LATER, { actor: { id: "ops-1" }, reason: "why" })
        ?.notices,
    ).toStrictEqual([
      {
        recipient: "listener:audit",
        at: AT,
        notice: {
          kind: PauseNoticeKind.TimeoutChanged,
          writtenAt: AT.toISOString(),
          expiresAt: LATER,
          previousExpiresAt: EARLIER,
          actor: { id: "ops-1" },
          changeReason: "why",
        },
      },
    ]);
    expect(change(sent(), LATER)?.notices[0]?.notice).toStrictEqual({
      kind: PauseNoticeKind.TimeoutChanged,
      writtenAt: AT.toISOString(),
      expiresAt: LATER,
    });
    expect(change(sent({ expiresAt: LATER }), undefined)?.notices[0]?.notice).toStrictEqual({
      kind: PauseNoticeKind.TimeoutChanged,
      writtenAt: AT.toISOString(),
      previousExpiresAt: LATER,
    });
  });

  it("a deadline set exactly to the one the pause was made under keeps that deadline's source", () => {
    const made = sent({
      expiresAt: LATER,
      boundAt: "2026-01-05T11:30:00.000Z",
      expiryBound: PauseExpiryBound.Quorum,
    });

    expect(change(made, "2026-01-05T11:30:00.000Z")?.pause.expiryBound).toBe(
      PauseExpiryBound.Quorum,
    );
    expect(change(made, "2026-01-05T11:20:00.000Z")?.pause.expiryBound).toBe(
      PauseExpiryBound.Pause,
    );
  });
});

describe("agbossjs/agboss#1307: an answer over the pause as it was seen", () => {
  const answer = { decision: { ok: true }, actor: undefined };

  it("resolve: with a `seen` only while the pause is still that one; with none, unguarded", () => {
    const before = sent();
    const stale = { ...seenOf(before), trailLength: 7 };

    expect(resolveChange(before, answer, AT, AUDIT, seenOf(before))?.pause.status).toBe("resolved");
    expect(resolveChange(before, answer, AT, AUDIT)?.pause.status).toBe("resolved");
    expect(resolveChange(before, answer, AT, AUDIT, stale)).toBeUndefined();
  });

  it("decide: Taken / Decided with no notice, only while the pause is still the one the channel was sent", () => {
    const before = sent({ isSent: false });

    const decided = decideChange(before, answer, AT, seenOf(before));

    expect(decided).toStrictEqual({
      pause: {
        ...before,
        status: PauseStatus.Taken,
        resolution: PauseResolution.Decided,
        resolvedAt: AT.toISOString(),
        answer,
      },
      notices: [],
    });
    expect(
      decideChange({ ...before, assignees: ["x"] }, answer, AT, seenOf(before)),
    ).toBeUndefined();
    expect(
      decideChange({ ...before, expiresAt: LATER }, answer, AT, seenOf(before)),
    ).toBeUndefined();
  });
});

describe("agbossjs/agboss#1213: a reminder", () => {
  it("a pause with no deadline has none", () => {
    expect(remindChange(sent(), AT, AUDIT)).toBeUndefined();
  });

  it("its notice names the deadline, and the reminder is not asked again", () => {
    const change = remindChange(sent({ expiresAt: LATER, remindAt: EARLIER }), AT, AUDIT);

    expect(change?.notices).toStrictEqual([
      {
        recipient: "listener:audit",
        at: AT,
        notice: { kind: PauseNoticeKind.Expiring, writtenAt: AT.toISOString(), expiresAt: LATER },
      },
    ]);
    expect(change?.pause.remindAt).toBeUndefined();
  });
});
