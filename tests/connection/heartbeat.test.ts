/**
 * agbossjs/agboss#789, #1213: `watchLiveness` pings a connection every half of its liveness bound
 * and says why it is dead — a failed ping, or one not answered within the other half — or nothing
 * when the watch is ended first. Every wait is on the test clock.
 */
import { VirtualClock } from "@agboss/core/testing";
import { seconds, type Milliseconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { watchLiveness } from "../../src/connection/heartbeat.js";

/** A clock that remembers the signal of every sleep it was given. */
class RecordingClock extends VirtualClock {
  readonly signals: (AbortSignal | undefined)[] = [];

  override sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    this.signals.push(signal);
    return super.sleep(delay, signal);
  }
}

/** A ping that counts its calls and answers as `answer` says. */
function pinger(answer: () => Promise<unknown>): { ping: () => Promise<unknown>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    ping: () => {
      calls.push(calls.length + 1);
      return answer();
    },
  };
}

const watching = (clock: VirtualClock, ping: () => Promise<unknown>, signal?: AbortSignal) => {
  const state: { result?: string; isEnded: boolean } = { isEnded: false };
  const done = watchLiveness({
    clock,
    livenessSeconds: 10,
    ping,
    signal: signal ?? new AbortController().signal,
  }).then((result) => {
    state.result = result;
    state.isEnded = true;
  });
  return { state, done };
};

describe("watchLiveness", () => {
  it("pings every half of the bound, and keeps pinging while it is answered", async () => {
    const clock = new VirtualClock();
    const probe = pinger(() => Promise.resolve("pong"));
    const control = new AbortController();
    const { state, done } = watching(clock, probe.ping, control.signal);

    await clock.advance(seconds(4.999));
    expect(probe.calls).toEqual([]);
    await clock.advance("1ms");
    expect(probe.calls).toEqual([1]);
    await clock.advance(seconds(5));
    expect(probe.calls).toEqual([1, 2]);
    expect(state.isEnded).toBe(false);

    control.abort();
    await done;
    expect(state.result).toBeUndefined();
  });

  it("a ping that fails is the reason: its message", async () => {
    const clock = new VirtualClock();
    const { state, done } = watching(clock, pinger(() => Promise.reject(new Error("reset"))).ping);

    await clock.advance(seconds(5));
    await done;

    expect(state.result).toBe("the ping failed: reset");
  });

  it("a ping that fails with a non-error is a failed ping with no message", async () => {
    const clock = new VirtualClock();
    const reason: unknown = "reset";
    const refused = async (): Promise<never> => {
      await Promise.resolve();
      throw reason;
    };
    const { state, done } = watching(clock, pinger(refused).ping);

    await clock.advance(seconds(5));
    await done;

    expect(state.result).toBe("the ping failed: error");
  });

  it("a ping not answered within the other half is dead: the half is named", async () => {
    const clock = new VirtualClock();
    const { state, done } = watching(clock, pinger(() => new Promise(() => undefined)).ping);

    await clock.advance(seconds(5));
    await clock.advance(seconds(4.999));
    expect(state.isEnded).toBe(false);
    await clock.advance("1ms");
    await done;

    expect(state.result).toBe("no answer to a ping in 5 s");
  });

  it("a watch ended before the first ping never pings", async () => {
    const clock = new VirtualClock();
    const probe = pinger(() => Promise.resolve());
    const control = new AbortController();
    const { state, done } = watching(clock, probe.ping, control.signal);

    control.abort();
    await done;

    expect(state.result).toBeUndefined();
    expect(probe.calls).toEqual([]);
  });

  it("a watch ended while a ping is out and silent is no reason", async () => {
    const clock = new VirtualClock();
    const control = new AbortController();
    const probe = pinger(() => new Promise<void>(() => undefined));
    const { state, done } = watching(clock, probe.ping, control.signal);
    await clock.advance(seconds(5));
    expect(probe.calls).toEqual([1]);

    control.abort();
    await done;

    expect(state.result).toBeUndefined();
  });

  it("a watch ended as its ping fails is no reason either", async () => {
    const clock = new VirtualClock();
    const control = new AbortController();
    const probe = pinger(() => {
      control.abort();
      return Promise.reject(new Error("closed"));
    });
    const { state, done } = watching(clock, probe.ping, control.signal);

    await clock.advance(seconds(5));
    await done;

    expect(state.result).toBeUndefined();
  });

  it("a watch ended as its ping is answered is no reason either, and does not ping again", async () => {
    const clock = new VirtualClock();
    const control = new AbortController();
    const probe = pinger(() => {
      control.abort();
      return Promise.resolve("pong");
    });
    const { state, done } = watching(clock, probe.ping, control.signal);

    await clock.advance(seconds(5));
    await done;

    expect(state.result).toBeUndefined();
    expect(probe.calls).toEqual([1]);
  });

  it("the wait for an answer is ended once the ping is answered", async () => {
    const clock = new RecordingClock();
    const control = new AbortController();
    const { done } = watching(clock, pinger(() => Promise.resolve("pong")).ping, control.signal);

    await clock.advance(seconds(5));
    const [, answerWait] = clock.signals;
    const isEnded = answerWait?.aborted;
    control.abort();
    await done;

    expect(isEnded).toBe(true);
  });
});
