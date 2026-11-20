/**
 * agbossjs/agboss#91: the kill of a dropped stream's cursors and the wait for a stream's
 * aggregates, each branch of them, on fakes (a database that answers as the test says, a clock
 * whose sleeps end at once or never, a client of events): a kill spares the live stream's cursor;
 * a kill that fails or is not answered within the close bound is warned about once, with the
 * error's code, in the one text, and the late answer of one that was given up is not warned about
 * again; a kill answered in time says nothing; `unlisten` takes back each of the three listeners;
 * a wait that ends stops its own sleep.
 */
import { Clock } from "@agboss/core";
import { seconds, type Milliseconds } from "@agboss/core/units";
import { Long, type Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { Collections } from "../../src/connection/collections.js";
import {
  awaitAnswer,
  killDropped,
  listenForAggregates,
  type Orphan,
} from "../../src/stores/queue-watch-cursors.js";

const NS = `app.${Collections.ChildExecutionQueue}`;
const orphan = (id: bigint, generation: number): Orphan => ({ id, ns: NS, generation });

/** A clock whose sleeps end at once (`ends`) or never, and the signals they were given. */
class SleepClock extends Clock {
  readonly signals: (AbortSignal | undefined)[] = [];

  constructor(private readonly ends: boolean) {
    super();
  }

  now(): Date {
    return new Date(0);
  }

  sleep(_delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    this.signals.push(signal);
    return this.ends ? Promise.resolve() : new Promise(() => undefined);
  }
}

type Fake = Pick<Db, "databaseName" | "command">;
const dbThat = (command: Fake["command"]): Fake => ({ databaseName: "app", command });
/** A command that fails with `error`, whatever it is (the driver's own are `MongoServerError`s with a code). */
const failing = (error: unknown): Promise<never> =>
  Promise.resolve().then(() => {
    throw error;
  });
const MESSAGE = (why: string): string =>
  `The child queue's dropped change stream's cursor could not be killed on the server (${why}); the server drops it once it times out`;

describe("agbossjs/agboss#91: the kill of a dropped stream's cursors", () => {
  it("never touches the cursor of the stream that is live", async () => {
    const command = vi.fn(() => Promise.resolve({}));

    await killDropped(
      dbThat(command),
      [orphan(5n, 2), orphan(6n, 3)],
      3,
      new SleepClock(false),
      vi.fn(),
    );

    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith({
      killCursors: Collections.ChildExecutionQueue,
      cursors: [Long.fromBigInt(5n)],
    });
  });

  it("an answered kill says nothing, however it was bounded", async () => {
    const warn = vi.fn();

    await killDropped(
      dbThat(() => Promise.resolve({})),
      [orphan(5n, 1)],
      undefined,
      new SleepClock(false),
      warn,
    );

    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: 2 }, "error 2"],
    [{ code: "Unauthorized" }, "error Unauthorized"],
    [new Error("no code"), "error without a code"],
  ])("a kill the server rejects (%j) is warned about, by its code", async (error, why) => {
    const warn = vi.fn();

    await killDropped(
      dbThat(() => failing(error)),
      [orphan(5n, 1)],
      undefined,
      new SleepClock(false),
      warn,
    );

    expect(warn.mock.calls).toEqual([[MESSAGE(why)]]);
  });

  it("a kill not answered within the bound is warned about, once, though its failure comes late", async () => {
    const warn = vi.fn();
    let fail: (error: unknown) => void = () => undefined;
    const late = new Promise<never>((_resolve, reject) => {
      fail = (error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      };
    });

    await killDropped(
      dbThat(() => late),
      [orphan(5n, 1)],
      undefined,
      new SleepClock(true),
      warn,
    );
    expect(warn.mock.calls).toEqual([[MESSAGE("no answer within the close bound")]]);
    fail(Object.assign(new Error("late"), { code: 11 }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("agbossjs/agboss#91: the wait for a stream's aggregates", () => {
  type Name = "commandStarted" | "commandSucceeded" | "commandFailed";
  /** A client of events that knows which listeners are on it. */
  const client = () => {
    const on = new Map<Name, ((event: { commandName: string }) => void)[]>();
    return {
      on: vi.fn((name: Name, listener: (event: { commandName: string }) => void) => {
        on.set(name, [...(on.get(name) ?? []), listener]);
      }),
      off: vi.fn((name: Name, listener: (event: { commandName: string }) => void) => {
        on.set(
          name,
          (on.get(name) ?? []).filter((one) => one !== listener),
        );
      }),
      emit: (name: Name, commandName: string) => {
        for (const listener of on.get(name) ?? []) listener({ commandName });
      },
      heard: (name: Name) => (on.get(name) ?? []).length,
    };
  };
  const wait = (waiting: Promise<void>) => {
    let done = false;
    void waiting.then(() => {
      done = true;
    });
    return () => done;
  };
  const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("a waiter stays while an aggregate is in flight, whichever of two ends first", async () => {
    const events = client();
    const { answered } = listenForAggregates(events as never);
    events.emit("commandStarted", "aggregate");
    events.emit("commandStarted", "aggregate");
    const isDone = wait(answered());

    events.emit("commandSucceeded", "aggregate");
    await turn();
    expect(isDone()).toBe(false);
    events.emit("commandSucceeded", "aggregate");
    await turn();
    expect(isDone()).toBe(true);
  });

  it("unlisten takes back each of its three listeners", () => {
    const events = client();
    const { unlisten } = listenForAggregates(events as never);
    expect(
      ["commandStarted", "commandSucceeded", "commandFailed"].map((n) => events.heard(n as Name)),
    ).toEqual([1, 1, 1]);

    unlisten();

    expect(
      ["commandStarted", "commandSucceeded", "commandFailed"].map((n) => events.heard(n as Name)),
    ).toEqual([0, 0, 0]);
  });

  it("a waiter registered after the events stopped is released by nothing that is heard later", async () => {
    const events = client();
    const { answered, unlisten } = listenForAggregates(events as never);
    unlisten();
    events.emit("commandFailed", "aggregate");

    const isDone = wait(answered());
    await turn();

    expect(isDone()).toBe(false);
  });
});

describe("agbossjs/agboss#91: awaitAnswer", () => {
  it("stops its own sleep once the answer is there", async () => {
    const clock = new SleepClock(false);

    await awaitAnswer(() => Promise.resolve(), clock, seconds(5));

    expect(clock.signals).toHaveLength(1);
    expect(clock.signals[0]?.aborted).toBe(true);
  });

  it("ends at the bound when there is no answer", async () => {
    const clock = new SleepClock(true);

    await awaitAnswer(() => new Promise(() => undefined), clock, seconds(5));

    expect(clock.signals[0]?.aborted).toBe(true);
  });
});
