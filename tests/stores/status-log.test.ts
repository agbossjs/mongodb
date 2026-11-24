/**
 * agbossjs/agboss#1341d on MongoDB: the rules that say which write is a change of a thread's status
 * (the core's `transitionOf` and `recordTransitionOf`, restated from its public enums) — pure, so a
 * mutant of one is a failing test here, not a wait for a database.
 */
import { StatusTrigger, ThreadStatus, type ThreadStatusTransition } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { recordTransitionOf, transitionOf } from "../../src/stores/status-log.js";

const THREAD = { tenantId: "default", threadId: "thread-1" };
const AT = new Date("2026-01-05T09:00:00.000Z");

const last = (toStatus: ThreadStatus, seq = 1): ThreadStatusTransition => ({
  ...THREAD,
  seq,
  fromStatus: null,
  toStatus,
  trigger: StatusTrigger.Start,
  at: AT,
});

describe("transitionOf", () => {
  it("the first change is seq 1 from nothing, at the store's time", () => {
    expect(
      transitionOf(
        { ...THREAD, toStatus: ThreadStatus.Running, trigger: StatusTrigger.Start },
        undefined,
        AT,
      ),
    ).toEqual({
      ...THREAD,
      seq: 1,
      fromStatus: null,
      toStatus: ThreadStatus.Running,
      trigger: StatusTrigger.Start,
      at: AT,
    });
  });

  it("a change is one more than the last, from the last's status; reason, actor and lease token are kept when given", () => {
    const written = transitionOf(
      {
        ...THREAD,
        toStatus: ThreadStatus.Stopping,
        trigger: StatusTrigger.Stop,
        reason: "audit",
        actor: "ops-1",
        leaseToken: 3,
      },
      last(ThreadStatus.Running, 4),
      AT,
    );

    expect(written).toMatchObject({
      seq: 5,
      fromStatus: ThreadStatus.Running,
      reason: "audit",
      actor: "ops-1",
      leaseToken: 3,
    });
  });

  it("a status the thread already has is no change", () => {
    expect(
      transitionOf(
        { ...THREAD, toStatus: ThreadStatus.Paused, trigger: StatusTrigger.Ask },
        last(ThreadStatus.Paused),
        AT,
      ),
    ).toBeUndefined();
  });

  it.each([ThreadStatus.Stopping, ThreadStatus.Cancelling])(
    "a record moving through running while the thread is %s is no change",
    (status) => {
      expect(
        transitionOf(
          { ...THREAD, toStatus: ThreadStatus.Running, trigger: StatusTrigger.Resume },
          last(status),
          AT,
        ),
      ).toBeUndefined();
    },
  );

  it("an entry with no reason, actor or lease token has none of them, not an undefined one", () => {
    const written = transitionOf(
      { ...THREAD, toStatus: ThreadStatus.Failed, trigger: StatusTrigger.Fail },
      undefined,
      AT,
    );

    for (const field of ["reason", "actor", "leaseToken"])
      expect(written).not.toHaveProperty(field);
  });
});

describe("recordTransitionOf", () => {
  it.each([
    ["running", ThreadStatus.Running, StatusTrigger.Start],
    ["paused", ThreadStatus.Paused, StatusTrigger.Ask],
    ["answered", ThreadStatus.Finished, StatusTrigger.Finish],
    ["guarded", ThreadStatus.Finished, StatusTrigger.Finish],
    ["failed", ThreadStatus.Failed, StatusTrigger.Fail],
    ["stopped", ThreadStatus.Stopped, StatusTrigger.Stop],
    ["cancelled", ThreadStatus.Cancelled, StatusTrigger.Cancel],
  ])("a %s record makes %s by %s", (status, to, trigger) => {
    expect(recordTransitionOf(THREAD, status, undefined, undefined)).toEqual({
      ...THREAD,
      toStatus: to,
      trigger,
    });
  });

  it.each(["queued", "written"])("a %s record makes no thread status", (status) => {
    expect(recordTransitionOf(THREAD, status, undefined, undefined)).toBeUndefined();
  });

  it("running again after a pause is a resume, after a dual pause too; after anything else a start", () => {
    for (const before of [ThreadStatus.Paused, ThreadStatus.DualPaused])
      expect(recordTransitionOf(THREAD, "running", last(before), undefined)).toMatchObject({
        trigger: StatusTrigger.Resume,
      });
    expect(
      recordTransitionOf(THREAD, "running", last(ThreadStatus.Failed), undefined),
    ).toMatchObject({
      trigger: StatusTrigger.Start,
    });
  });

  it("a command's context names the status, the trigger and the details of its write", () => {
    expect(
      recordTransitionOf(THREAD, "paused", undefined, {
        toStatus: ThreadStatus.ExternallyPaused,
        trigger: StatusTrigger.Pause,
        reason: "hold",
        actor: "ops-1",
        leaseToken: 2,
      }),
    ).toEqual({
      ...THREAD,
      toStatus: ThreadStatus.ExternallyPaused,
      trigger: StatusTrigger.Pause,
      reason: "hold",
      actor: "ops-1",
      leaseToken: 2,
    });
  });
});
