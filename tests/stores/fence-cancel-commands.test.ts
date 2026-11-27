/**
 * The cancel mark and the fence a fenced write reads, as the client sends and decides them (a fake
 * collection, no server): the mark's update and when its history document is written, the pause
 * fence of a root's key and of a child's, the scope mark's expiry expression.
 */
import { StoreClock, StoreTimeSource } from "@agboss/core";
import { pauseFencedOf } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { effectKeyForTesting } from "@agboss/core/testing/contracts";
import type { Db } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkCancel, markCancel } from "../../src/stores/cancel-fence.js";
import { latestExpiry } from "../../src/stores/fence.js";

const logged = vi.hoisted(() => vi.fn());

vi.mock("../../src/stores/lease-marks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/stores/lease-marks.js")>()),
  logged,
}));

const CLOCK = new StoreClock(StoreTimeSource.Test, new VirtualClock());
const TREE = { tenantId: "default", rootExecutionId: "root-1" };
const SESSION = { id: "session" } as never;

beforeEach(() => {
  logged.mockClear();
});

/** A database whose leases collection answers `before` to the mark's update. */
function marking(before: object | null) {
  const calls: unknown[][] = [];
  const collection = {
    findOneAndUpdate: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(before);
    },
  };
  return { db: { collection: () => collection } as never, calls };
}

describe("markCancel", () => {
  it("is one upserting update that answers the document as it was, in the caller's session", async () => {
    const { db, calls } = marking(null);

    await markCancel({ db, session: SESSION }, TREE, { clock: CLOCK, transition: undefined });

    expect(calls[0]?.[2]).toStrictEqual({
      upsert: true,
      returnDocument: "before",
      session: SESSION,
    });
  });

  it("sends no session when it has none", async () => {
    const { db, calls } = marking(null);

    await markCancel({ db, session: undefined }, TREE, { clock: CLOCK, transition: undefined });

    expect(calls[0]?.[2]).toStrictEqual({ upsert: true, returnDocument: "before" });
  });

  it("writes the history document when this call set the mark, and not when the mark was there", async () => {
    const scope = (before: object | null) => ({ ...marking(before), session: SESSION });
    const write = { clock: CLOCK, transition: undefined };

    const first = scope(null);
    await markCancel({ db: first.db, session: SESSION }, TREE, write);
    const seed = scope({ tenantId: "default" });
    await markCancel({ db: seed.db, session: SESSION }, TREE, write);
    expect(logged).toHaveBeenCalledTimes(2);

    logged.mockClear();
    const repeat = scope({ cancelRequestedAt: new Date("2026-01-05T09:00:00.000Z") });
    await markCancel({ db: repeat.db, session: SESSION }, TREE, write);
    expect(logged).not.toHaveBeenCalled();
  });
});

describe("checkCancel: the pause fence", () => {
  /** A database whose leases collection holds `row` as the tree's root document. */
  const holding = (row: object): Db =>
    ({
      collection: () => ({
        updateOne: () => Promise.resolve({}),
        findOne: () => Promise.resolve(row),
      }),
    }) as never;
  const keyOf = (token: number, leaseExecutionId: string) =>
    effectKeyForTesting({
      scopeKey: "default:root-1",
      tenantId: "default",
      leaseExecutionId,
      rootExecutionId: "root-1",
      token,
      idempotencyKey: `${leaseExecutionId}:charge:1`,
      name: "charge",
    });

  it("a root's key is refused at or below the fence, and writes above it", async () => {
    const db = holding({ token: 5, fencedThroughToken: 3 });

    await expect(checkCancel(db, SESSION, keyOf(3, "root-1"))).rejects.toThrowError(
      pauseFencedOf(keyOf(3, "root-1")),
    );
    await expect(checkCancel(db, SESSION, keyOf(4, "root-1"))).resolves.toBeUndefined();
  });

  it("a child's key is refused while its root's current token is the fenced one, and writes after", async () => {
    await expect(
      checkCancel(holding({ token: 3, fencedThroughToken: 3 }), SESSION, keyOf(10, "child-1")),
    ).rejects.toThrowError(pauseFencedOf(keyOf(10, "child-1")));
    await expect(
      checkCancel(holding({ token: 4, fencedThroughToken: 3 }), SESSION, keyOf(10, "child-1")),
    ).resolves.toBeUndefined();
  });

  it("a tree with no fence refuses no key, whatever the token of its seed document", async () => {
    await expect(
      checkCancel(holding({ token: 0 }), SESSION, keyOf(10, "child-1")),
    ).resolves.toBeUndefined();
    await expect(
      checkCancel(holding({ token: 1 }), SESSION, keyOf(1, "root-1")),
    ).resolves.toBeUndefined();
  });
});

describe("latestExpiry", () => {
  it("is none for Forever, else the first date over a missing one, none over a null, the later over a date", () => {
    expect(latestExpiry(null)).toBeNull();
    const at = new Date("2026-01-05T09:00:00.000Z");

    const expression = latestExpiry(at) as {
      $switch: { branches: { case: unknown; then: unknown }[]; default: unknown };
    };

    expect(expression.$switch.branches.map((branch) => branch.case)).toStrictEqual([
      { $eq: [{ $type: "$expiresAt" }, "missing"] },
      { $eq: [{ $type: "$expiresAt" }, "null"] },
    ]);
    expect(expression.$switch.branches[1]?.then).toBeNull();
    expect(JSON.stringify(expression.$switch.default)).toContain("$max");
  });
});
