/**
 * agbossjs/agboss#91: the first cluster time after a reply's (`startAfter`), where the change
 * stream starts — the next increment, the next second when the increment is the last of its
 * second, none when the reply has no time — and what the cursor listener says of a reply it cannot
 * read: nothing for a reply that holds no cursor (no document is not a failure), once, in words
 * that name the error's kind and nothing of the reply, for one it cannot read.
 */
import type { CommandSucceededEvent } from "mongodb";
import { Timestamp } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { startAfter } from "../../src/stores/queue-changes.js";
import { listenForCursors } from "../../src/stores/queue-watch-cursors.js";

/** Throws `value`, whatever it is: what a getter does that fails with something that is no error. */
const thrown = (value: unknown): never => {
  throw value;
};

describe("agbossjs/agboss#91: where the stream starts", () => {
  it.each([
    [new Timestamp({ t: 100, i: 7 }), 100, 8],
    [new Timestamp({ t: 100, i: 0 }), 100, 1],
    [new Timestamp({ t: 100, i: 0xfffffffe }), 100, 0xffffffff],
    [new Timestamp({ t: 100, i: 0xffffffff }), 101, 0],
  ])("the time %s is followed by %d, %d", (time, seconds, increment) => {
    const after = startAfter({ operationTime: time });

    expect(after).toBeInstanceOf(Timestamp);
    expect([after?.t, after?.i]).toEqual([seconds, increment]);
  });

  it.each([{}, { operationTime: 5 }, { operationTime: "7" }, { operationTime: null }])(
    "a reply with no cluster time (%j) gives none",
    (reply) => {
      expect(startAfter(reply)).toBeUndefined();
    },
  );
});

describe("agbossjs/agboss#91: what the cursor listener says", () => {
  const listener = () => {
    const handlers: ((event: CommandSucceededEvent) => void)[] = [];
    const warn = vi.fn();
    listenForCursors(
      {
        on: (_name, handler) => handlers.push(handler),
        off: () => undefined,
      },
      warn,
    );
    return {
      warn,
      emit: (event: unknown) => {
        for (const handler of handlers) handler(event as CommandSucceededEvent);
      },
    };
  };

  it.each([undefined, null])("a reply that is %s holds no cursor: nothing is said", (reply) => {
    const { emit, warn } = listener();

    emit({ commandName: "aggregate", reply });
    emit({ commandName: "getMore", reply });

    expect(warn).not.toHaveBeenCalled();
  });

  it("a reply it cannot read is said once, naming the kind of the error", () => {
    const { emit, warn } = listener();
    const hostile = {
      commandName: "aggregate",
      get reply(): never {
        throw new RangeError("secret document text");
      },
    };

    emit(hostile);
    emit(hostile);

    expect(warn.mock.calls).toEqual([
      [
        "The child queue's cursor listener could not read a command reply (RangeError); a cursor of its change stream may stay on the server until it times out",
      ],
    ]);
  });

  it("a thrown value that is no error is named by its type", () => {
    const { emit, warn } = listener();

    emit({
      commandName: "aggregate",
      get reply(): never {
        return thrown("secret");
      },
    });

    expect(String(warn.mock.calls[0]?.[0])).toContain("(string)");
  });
});
