/**
 * agbossjs/agboss#923 — the close at an instance's stop: in order when the server answers, given
 * up past the grace when it does not, its late failure dropped. On the test clock.
 */
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { CLOSE_GRACE, closeBounded } from "../../src/connection/close-bounded.js";

describe("closeBounded", () => {
  it("a close that ends returns at once", async () => {
    await expect(
      closeBounded(() => Promise.resolve(), new VirtualClock()),
    ).resolves.toBeUndefined();
  });

  it("a close that never ends is given up once the grace passed on the clock", async () => {
    const clock = new VirtualClock();
    let isDone = false;
    const closing = closeBounded(() => new Promise(() => undefined), clock).then(() => {
      isDone = true;
    });

    await clock.advance("999ms");
    expect(isDone).toBe(false);
    await clock.advance("1ms");
    await closing;

    expect(isDone).toBe(true);
  });

  it("a late failure of a given-up close is dropped: nothing rejects unhandled", async () => {
    const clock = new VirtualClock();
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let fail: (error: Error) => void = () => undefined;
    const closing = closeBounded(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
      clock,
    );

    await clock.advance(CLOSE_GRACE);
    await closing;
    fail(new Error("the server answered at last"));
    await new Promise((done) => setImmediate(done));
    process.off("unhandledRejection", onUnhandled);

    expect(seen).toEqual([]);
  });

  it("without a clock the close is the orderly one only", async () => {
    await expect(closeBounded(() => Promise.resolve(), undefined)).resolves.toBeUndefined();
  });
});
