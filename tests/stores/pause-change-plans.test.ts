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
import { PauseNoticeKind, type PauseRecipients } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import {
  cancelChange,
  closeUntakenChange,
  closedNotices,
  expireChange,
  extendChange,
  remindChange,
} from "../../src/stores/paused/pause-changes.js";
import { pauseOf } from "../support/pauses.js";

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

describe("agbossjs/agboss#1213: a deadline extension", () => {
  const extend = (before: PauseRecord, expiresAt: string) =>
    extendChange(before, { expiresAt, previousExpiresAt: EARLIER, remindAt: undefined }, AT, AUDIT);

  it("a pause with no deadline is not extended", () => {
    expect(extend(sent(), LATER)).toBeUndefined();
  });

  it("a new deadline at or before `at` is refused; one after it is made", () => {
    const before = sent({ expiresAt: EARLIER });

    expect(extend(before, AT.toISOString())).toBeUndefined();
    expect(extend(before, "2026-01-05T09:59:59.000Z")).toBeUndefined();
    expect(extend(before, LATER)?.pause).toMatchObject({ expiresAt: LATER });
  });

  it("its notice names the new and the previous deadline, nothing else", () => {
    const change = extend(sent({ expiresAt: EARLIER }), LATER);

    expect(change?.notices).toStrictEqual([
      {
        recipient: "listener:audit",
        at: AT,
        notice: {
          kind: PauseNoticeKind.Extended,
          writtenAt: AT.toISOString(),
          expiresAt: LATER,
          previousExpiresAt: EARLIER,
        },
      },
    ]);
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
