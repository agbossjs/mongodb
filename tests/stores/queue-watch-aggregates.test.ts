/**
 * agbossjs/agboss#1345: a stop waits for the stream's `aggregate` calls to be answered, because the
 * reply is the only place a cursor's id is told. The listener's answer: not before the first
 * `aggregate` has ended (a reply or a failure), and not while another is in flight; `getMore`s and
 * other commands do not count; `unlisten` releases a waiter.
 */
import type { CommandFailedEvent, CommandStartedEvent, CommandSucceededEvent } from "mongodb";
import { describe, expect, it } from "vitest";
import { listenForAggregates } from "../../src/stores/queue-watch-cursors.js";

type Event = "commandStarted" | "commandSucceeded" | "commandFailed";
type Listener = (event: CommandStartedEvent & CommandSucceededEvent & CommandFailedEvent) => void;

/** A client of command events only. */
class FakeClient {
  readonly #listeners = new Map<Event, Set<Listener>>();

  on(event: Event, listener: Listener): this {
    this.#listeners.set(event, (this.#listeners.get(event) ?? new Set()).add(listener));
    return this;
  }

  off(event: Event, listener: Listener): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: Event, commandName: string): void {
    for (const listener of this.#listeners.get(event) ?? [])
      listener({ commandName } as CommandStartedEvent & CommandSucceededEvent & CommandFailedEvent);
  }
}

/** Whether `promise` has settled by the time the microtasks have run. */
const settled = async (promise: Promise<void>): Promise<boolean> => {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
};

describe("agbossjs/agboss#1345: the stream's aggregates are answered", () => {
  it("is not answered before the first aggregate has ended, then is", async () => {
    const client = new FakeClient();
    const { answered } = listenForAggregates(client as never);
    expect(await settled(answered())).toBe(false);
    client.emit("commandStarted", "aggregate");
    expect(await settled(answered())).toBe(false);
    client.emit("commandSucceeded", "aggregate");
    expect(await settled(answered())).toBe(true);
  });

  it("a failed aggregate ends it as a reply does", async () => {
    const client = new FakeClient();
    const { answered } = listenForAggregates(client as never);
    client.emit("commandStarted", "aggregate");
    const waiting = answered();
    client.emit("commandFailed", "aggregate");
    expect(await settled(waiting)).toBe(true);
  });

  it("an aggregate sent to resume is waited for too", async () => {
    const client = new FakeClient();
    const { answered } = listenForAggregates(client as never);
    client.emit("commandStarted", "aggregate");
    client.emit("commandSucceeded", "aggregate");
    client.emit("commandStarted", "aggregate");
    expect(await settled(answered())).toBe(false);
    client.emit("commandSucceeded", "aggregate");
    expect(await settled(answered())).toBe(true);
  });

  it("other commands do not count", async () => {
    const client = new FakeClient();
    const { answered } = listenForAggregates(client as never);
    client.emit("commandStarted", "getMore");
    client.emit("commandSucceeded", "getMore");
    client.emit("commandSucceeded", "ping");
    expect(await settled(answered())).toBe(false);
  });

  it("unlisten releases a waiter and the events are no longer heard", async () => {
    const client = new FakeClient();
    const { answered, unlisten } = listenForAggregates(client as never);
    const waiting = answered();
    unlisten();
    expect(await settled(waiting)).toBe(true);
    const again = listenForAggregates(client as never);
    client.emit("commandStarted", "aggregate");
    client.emit("commandSucceeded", "aggregate");
    expect(await settled(again.answered())).toBe(true);
  });
});
