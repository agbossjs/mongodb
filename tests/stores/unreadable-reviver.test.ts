/**
 * `parsedOrUnreadable` hands the core's `parsedStoredJson` what it was given and nothing it was not:
 * no `reviver` key at all when there is none (a key holding `undefined` is another call).
 */
import { describe, expect, it, vi } from "vitest";

const parsed = vi.hoisted(() => vi.fn(() => ({ parsed: true })));

vi.mock("@agboss/core/stores", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agboss/core/stores")>()),
  parsedStoredJson: parsed,
}));

describe("parsedOrUnreadable", () => {
  it("passes what, text and ids, and no reviver key when none was given", async () => {
    const { parsedOrUnreadable } = await import("../../src/stores/unreadable.js");

    parsedOrUnreadable("a thing", "{}", { id: "1" });

    expect(parsed).toHaveBeenLastCalledWith({ what: "a thing", text: "{}", ids: { id: "1" } });
  });

  it("passes the reviver when there is one", async () => {
    const { parsedOrUnreadable } = await import("../../src/stores/unreadable.js");
    const reviver = (_key: string, value: unknown): unknown => value;

    parsedOrUnreadable("a thing", "{}", {}, reviver);

    expect(parsed).toHaveBeenLastCalledWith({ what: "a thing", text: "{}", ids: {}, reviver });
  });
});
