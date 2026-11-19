/**
 * agbossjs/agboss#1104, #1260: the pace of a start's wait for live leases is the connection's
 * `Clock` — a poll of `pollMs` sleeps that many milliseconds on it, and a connection with no clock
 * cannot wait at all.
 */
import { VirtualClock } from "@agboss/core/testing";
import { seconds, type Milliseconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { sleepOn } from "../../src/connection/live-leases.js";

/** A clock that remembers every delay it was asked to sleep, and sleeps none of them. */
class RecordingClock extends VirtualClock {
  readonly delays: Milliseconds[] = [];

  override sleep(delay: Milliseconds): Promise<void> {
    this.delays.push(delay);
    return Promise.resolve();
  }
}

describe("the wait's sleep on the connection's clock", () => {
  it("a poll of 1500 ms sleeps 1.5 s on the clock, 200 ms a fifth of a second", async () => {
    const clock = new RecordingClock();
    const sleep = sleepOn(clock);

    await sleep?.(1500);
    await sleep?.(200);

    expect(clock.delays).toEqual([seconds(1.5), seconds(0.2)]);
  });

  it("no clock, no sleep: the start cannot wait", () => {
    expect(sleepOn(undefined)).toBeUndefined();
  });
});
