/**
 * agbossjs/mongodb#99: the order of one instance's fenced calls (agbossjs/agboss#527): the calls
 * of one owner on one key run one after another, in the order they were made; other keys and other
 * owners never wait for them; a call that failed does not stop the ones after it; and a key whose
 * calls are all done keeps nothing.
 */
import { describe, expect, it } from "vitest";
import { fencedOrderKeysOf, inLocalOrder } from "../../src/stores/local-order.js";

/** A call that runs when `release` is called, and says when it started. */
function manual<TValue>(value: TValue) {
  const events: string[] = [];
  let release: () => void = () => undefined;
  let fail: (reason: unknown) => void = () => undefined;
  const finished = new Promise<TValue>((resolve, reject) => {
    release = () => {
      resolve(value);
    };
    fail = reject;
  });
  return {
    events,
    release: () => {
      release();
    },
    fail: (reason: unknown) => {
      fail(reason);
    },
    call: (name: string) => () => {
      events.push(`${name} started`);
      return finished;
    },
  };
}

/** Lets every promise that can settle without a timer settle. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("inLocalOrder: the calls of one owner on one key", () => {
  it("a call waits for the call made before it on its key, and runs after it", async () => {
    const owner = {};
    const log: string[] = [];
    const first = manual("one");

    const a = inLocalOrder(owner, ["k"], first.call("a"));
    const b = inLocalOrder(owner, ["k"], () => {
      log.push("b started");
      return Promise.resolve("two");
    });
    await flush();
    expect(first.events).toEqual(["a started"]);
    expect(log).toEqual([]);

    first.release();

    expect(await a).toBe("one");
    expect(await b).toBe("two");
    expect(log).toEqual(["b started"]);
  });

  it("three calls run in the order they were made", async () => {
    const owner = {};
    const order: string[] = [];
    const slow = (name: string, ms: number) => () =>
      new Promise<string>((resolve) =>
        setTimeout(() => {
          order.push(name);
          resolve(name);
        }, ms),
      );

    const results = await Promise.all([
      inLocalOrder(owner, ["k"], slow("a", 30)),
      inLocalOrder(owner, ["k"], slow("b", 1)),
      inLocalOrder(owner, ["k"], slow("c", 10)),
    ]);

    expect(order).toEqual(["a", "b", "c"]);
    expect(results).toEqual(["a", "b", "c"]);
  });

  it("calls on other keys do not wait", async () => {
    const owner = {};
    const blocked = manual("x");
    const events: string[] = [];

    const a = inLocalOrder(owner, ["k1"], blocked.call("a"));
    const b = inLocalOrder(owner, ["k2"], () => {
      events.push("b started");
      return Promise.resolve("y");
    });

    expect(await b).toBe("y");
    expect(events).toEqual(["b started"]);
    expect(blocked.events).toEqual(["a started"]);
    blocked.release();
    expect(await a).toBe("x");
  });

  it("a call on several keys waits for the calls before it on every one of them", async () => {
    const owner = {};
    const onFirst = manual("a");
    const onSecond = manual("b");
    const events: string[] = [];

    const a = inLocalOrder(owner, ["k1"], onFirst.call("a"));
    const b = inLocalOrder(owner, ["k2"], onSecond.call("b"));
    const both = inLocalOrder(owner, ["k1", "k2"], () => {
      events.push("both started");
      return Promise.resolve("ab");
    });
    await flush();
    expect(events).toEqual([]);

    onFirst.release();
    await a;
    await flush();
    expect(events).toEqual([]);

    onSecond.release();
    await b;
    expect(await both).toBe("ab");
    expect(events).toEqual(["both started"]);
  });

  it("a call on one of those keys, made after, waits for the call on both", async () => {
    const owner = {};
    const first = manual("both");
    const events: string[] = [];

    const both = inLocalOrder(owner, ["k1", "k2"], first.call("both"));
    const onSecond = inLocalOrder(owner, ["k2"], () => {
      events.push("k2 started");
      return Promise.resolve("k2");
    });
    await flush();
    expect(events).toEqual([]);

    first.release();
    await both;

    expect(await onSecond).toBe("k2");
    expect(events).toEqual(["k2 started"]);
  });

  it("another owner's calls on the same key do not wait", async () => {
    const blocked = manual("x");
    const events: string[] = [];

    const a = inLocalOrder({}, ["k"], blocked.call("a"));
    const b = inLocalOrder({}, ["k"], () => {
      events.push("b started");
      return Promise.resolve("y");
    });

    expect(await b).toBe("y");
    expect(events).toEqual(["b started"]);
    blocked.release();
    await a;
  });
});

describe("inLocalOrder: a call that failed", () => {
  it("rejects with its own error, and the call after it runs", async () => {
    const owner = {};
    const first = manual("never");
    const events: string[] = [];

    const a = inLocalOrder(owner, ["k"], first.call("a"));
    const b = inLocalOrder(owner, ["k"], () => {
      events.push("b started");
      return Promise.resolve("two");
    });
    const failed = a.then(
      () => "resolved",
      (error: unknown) => error,
    );
    await flush();
    expect(events).toEqual([]);

    const reason = new Error("a failed");
    first.fail(reason);

    expect(await failed).toBe(reason);
    expect(await b).toBe("two");
    expect(events).toEqual(["b started"]);
  });

  it("a call whose function throws at once is a rejection, and the next call runs", async () => {
    const owner = {};
    const a = inLocalOrder(owner, ["k"], () => {
      throw new Error("sync");
    });
    const b = inLocalOrder(owner, ["k"], () => Promise.resolve("two"));

    await expect(a).rejects.toThrow("sync");
    expect(await b).toBe("two");
  });
});

describe("inLocalOrder: the queue of a key", () => {
  /** How many turns of the microtask queue pass before a call on `keys` of `owner` runs. */
  async function turnsBeforeRun(owner: object, keys: readonly string[]): Promise<number> {
    const run = { done: false };
    const done = inLocalOrder(owner, keys, () => {
      run.done = true;
      return Promise.resolve();
    });
    let turns = 0;
    while (!run.done) {
      await Promise.resolve();
      turns += 1;
    }
    await done;
    return turns;
  }

  it("a call with nothing before it on its keys waits for nothing: it runs as soon as a promise chain of no tail would", async () => {
    let bare = 0;
    const run = { done: false };
    void Promise.allSettled([]).then(() => {
      run.done = true;
    });
    while (!run.done) {
      await Promise.resolve();
      bare += 1;
    }

    expect(await turnsBeforeRun({}, ["k"])).toBe(bare);
    expect(await turnsBeforeRun({}, ["k1", "k2"])).toBe(bare);
  });

  it("keeps nothing of calls that are done: the next call on their keys runs as if there never were any", async () => {
    const used = {};
    await inLocalOrder(used, ["k1", "k2"], () => Promise.resolve());
    await inLocalOrder(used, ["k1"], () => Promise.reject(new Error("failed")))
      .then(() => undefined)
      .catch(() => undefined);
    await flush();

    const afterwards = await turnsBeforeRun(used, ["k1", "k2"]);
    const fresh = await turnsBeforeRun({}, ["k1", "k2"]);

    expect(afterwards).toBe(fresh);
  });

  it("a call done does not release the key of a call made after it that is still waiting", async () => {
    const owner = {};
    const second = manual("b");
    const events: string[] = [];
    const first = inLocalOrder(owner, ["k"], () => Promise.resolve("a"));
    const b = inLocalOrder(owner, ["k"], second.call("b"));
    await first;
    await flush();
    expect(second.events).toEqual(["b started"]);

    // `b` runs now: a call made after `a` ended must still wait for `b`
    const c = inLocalOrder(owner, ["k"], () => {
      events.push("c started");
      return Promise.resolve("c");
    });
    await flush();
    expect(events).toEqual([]);

    second.release();
    await b;
    expect(await c).toBe("c");
    expect(events).toEqual(["c started"]);
  });
});

describe("fencedOrderKeysOf: the keys a fenced call is ordered by", () => {
  it("a call with no business key is ordered by its lease alone", () => {
    expect(fencedOrderKeysOf({ tenantId: "t1", leaseExecutionId: "e1" }, "identity")).toEqual([
      '["lease","t1","e1"]',
    ]);
  });

  it("a call with a business key is ordered by its lease, then by its identity", () => {
    expect(
      fencedOrderKeysOf({ tenantId: "t1", leaseExecutionId: "e1", businessKey: "b1" }, "identity"),
    ).toEqual(['["lease","t1","e1"]', '["key","identity"]']);
  });

  it("another tenant's lease, or another identity, is another key", () => {
    const own = fencedOrderKeysOf(
      { tenantId: "t1", leaseExecutionId: "e1", businessKey: "b" },
      "i",
    );

    expect(
      fencedOrderKeysOf({ tenantId: "t2", leaseExecutionId: "e1", businessKey: "b" }, "i"),
    ).not.toContainEqual(own[0]);
    expect(
      fencedOrderKeysOf({ tenantId: "t1", leaseExecutionId: "e2", businessKey: "b" }, "i"),
    ).not.toContainEqual(own[0]);
    expect(
      fencedOrderKeysOf({ tenantId: "t1", leaseExecutionId: "e1", businessKey: "b" }, "j"),
    ).not.toContainEqual(own[1]);
  });
});
