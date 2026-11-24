/**
 * agbossjs/agboss#81: the keys of the pause scans' Mongo filters that no mutant of Stryker drops
 * (it empties a whole literal, never removes one key), each proved by a test that fails without
 * it. The keyset of a due scan passes exactly what lies before it in the scan's own order — a
 * tie of time is broken by the tenant, then by the pause, and nothing before it comes again; a
 * scan's filter implies the partial index that serves it (the plan names it); a retention removes
 * a closed pause whatever other pauses' mailboxes hold; a reminder is for a pending pause; a
 * channel is filled in on the pause it was read from, and over no channel set meanwhile.
 *
 * A key left as it is, no test can tell it (the sweep's equivalent): the `pauseId: { $in: … }` of
 * the retention's lookup of live mailboxes (the batch's pauses are the only ones the result is
 * compared with; the key keeps the lookup to their mailboxes instead of every live one).
 */
import { PauseStatus } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import type { Db, Document } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fillMissingChannels } from "../../src/connection/pause-channels.js";
import { Collections, MongoPausedExecutionRepository } from "../../src/index.js";
import { idOf } from "../../src/stores/keys.js";
import { commandsOf } from "../support/command-log.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { NINE, pauseOf } from "../support/pauses.js";
import { insertMailboxRow, insertPauseRow, insertTakenRow } from "../support/pause-rows.js";
import { connectionTo } from "../support/stores.js";

vi.mock("mongodb", async (importOriginal) => {
  const { reportingCommands } = await import("../support/command-log.js");
  return reportingCommands(await importOriginal());
});

const database = testDatabase();
const DUE = new Date(NINE.getTime() + 60_000);
const AFTER = new Date(DUE.getTime() + 60_000);

beforeEach(() => emptyAll(database.url()));

const storeOn = () =>
  new MongoPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());
const dbOf = () => connectionTo(database.url()).db;
/** `target[key]`, a method bound to `target`. */
function boundMember(target: object, key: string | symbol): unknown {
  const value: unknown = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
}

const idsOf = (pauses: readonly { readonly tenantId: string; readonly pauseId: string }[]) =>
  pauses.map((one) => `${one.tenantId}/${one.pauseId}`);

describe("agbossjs/agboss#81: the keyset of a due scan", () => {
  /** Pending pauses, each with a deadline `at` and the tenant and id it names. */
  async function pending(rows: readonly (readonly [string, string, Date])[]): Promise<void> {
    let seq = 0;
    for (const [tenantId, pauseId, at] of rows) {
      seq += 1;
      await insertPauseRow(dbOf(), pauseId, seq, {
        ...{ tenantId, rootExecutionId: `run-${pauseId}`, stepKey: `${tenantId}:${pauseId}` },
        expiresAt: at.toISOString(),
      });
    }
  }

  it("passes what lies at or before the cursor: a pause of the same tenant with a greater id (q) but an earlier time is behind it", async () => {
    await pending([
      ["default", "q", NINE],
      ["default", "n", DUE],
      ["default", "z", DUE],
    ]);

    const page = await storeOn().findPendingByExpiresAtBefore(AFTER, 10, {
      at: DUE.toISOString(),
      tenantId: "default",
      pauseId: "n",
    });

    expect(idsOf(page)).toEqual(["default/z"]);
  });

  it("breaks a tie of time by the tenant, then by the pause: a lesser tenant with a greater id is behind the cursor", async () => {
    await pending([
      ["a", "z", DUE],
      ["b", "a", DUE],
      ["b", "n", DUE],
      ["c", "a", DUE],
    ]);

    const page = await storeOn().findPendingByExpiresAtBefore(AFTER, 10, {
      at: DUE.toISOString(),
      tenantId: "b",
      pauseId: "a",
    });

    expect(idsOf(page)).toEqual(["b/n", "c/a"]);
  });
});

/** The `find` the store sent last on `collection`, explained: the plan's text. */
async function planOf(log: ReturnType<typeof commandsOf>, collection: string): Promise<string> {
  const sent = log.filter((one) => one.name === "find" && one.collection === collection).at(-1);
  if (sent === undefined) throw new Error("no find was sent");
  const { find, filter, sort, limit } = sent.command;
  const explain: Document = { find, filter, sort, limit };
  return JSON.stringify(await dbOf().command({ explain, verbosity: "queryPlanner" }));
}

describe("agbossjs/agboss#81: a scan's filter implies the partial index that serves it", () => {
  it.each([
    ["findPendingByExpiresAtBefore", "pending_by_expiry"],
    ["findPendingByRemindAtBefore", "pending_by_remind"],
    ["findPendingUnsentReassignedBefore", "reassigned_unsent"],
  ] as const)("%s reads %s", async (scan, index) => {
    const connection = connectionTo(database.url());
    const log = commandsOf(connection);
    const store = new MongoPausedExecutionRepository(connection, new VirtualClock());

    await store[scan](AFTER, 5);

    expect(await planOf(log, Collections.Pauses)).toContain(`"indexName":"${index}"`);
  });
});

describe("agbossjs/agboss#81: the retention of closed pauses", () => {
  it("removes a closed pause with no live mailbox, though another pause's mailbox is live", async () => {
    await insertTakenRow(dbOf(), "closed", 1, NINE.toISOString());
    await insertPauseRow(dbOf(), "open", 2);
    await insertMailboxRow(dbOf(), "open", { headWrittenAt: NINE, nextAttemptAt: NINE });

    await storeOn().deleteByResolvedAtBefore(DUE);

    expect(await dbOf().collection(Collections.Pauses).distinct("pauseId")).toEqual(["open"]);
  });
});

describe("agbossjs/agboss#81: a reminder", () => {
  it("is for a pending pause: a resolved one with a reminder due is not reminded", async () => {
    const store = storeOn();
    await insertPauseRow(
      dbOf(),
      "answered",
      1,
      { status: PauseStatus.Resolved, isSent: true },
      { remindAt: NINE, expiresAt: AFTER },
    );

    expect(
      await store.remindByTenantIdAndPauseId("default", "answered", DUE, { listeners: [] }),
    ).toBe(false);
  });
});

describe("agbossjs/agboss#81: the channel of a pause that lacks it", () => {
  const withoutChannel = async (id: string, channel: string, seq: number): Promise<void> => {
    await insertPauseRow(dbOf(), id, seq, { ...pauseOf(id), channel }, { channel: undefined });
    await dbOf()
      .collection<{ _id: string }>(Collections.Pauses)
      .updateOne({ _id: idOf("default", id) }, { $unset: { channel: "" } });
  };
  const channelOf = (id: string) =>
    dbOf()
      .collection<{ _id: string; channel?: string | null }>(Collections.Pauses)
      .findOne({ _id: idOf("default", id) }, { projection: { channel: 1 } });

  it("is read from its own record: each pause gets its own", async () => {
    await withoutChannel("first", "channel-a", 1);
    await withoutChannel("second", "channel-b", 2);

    await fillMissingChannels(dbOf(), {});

    expect((await channelOf("first"))?.channel).toBe("channel-a");
    expect((await channelOf("second"))?.channel).toBe("channel-b");
  });

  it("is never set over a channel another run set since it was read, nor on another pause", async () => {
    await withoutChannel("raced", "channel-a", 1);
    await withoutChannel("after", "channel-b", 2);
    const real = dbOf();
    const racing = new Proxy(real, {
      get(target, key) {
        if (key !== "collection") return boundMember(target, key);
        return (...args: Parameters<Db["collection"]>) => {
          const collection = target.collection<{ _id: string }>(...args);
          return new Proxy(collection, {
            get(inner, name) {
              if (name !== "find") return boundMember(inner, name);
              return async function* (...findArgs: Parameters<typeof inner.find>) {
                const stale = await inner.find(...findArgs).toArray();
                // another instance gave the first a channel after this one read it
                await inner.updateOne(
                  { _id: idOf("default", "raced") },
                  { $set: { channel: "channel-set-meanwhile" } },
                );
                yield* stale;
              };
            },
          });
        };
      },
    });

    await fillMissingChannels(racing, {});

    expect((await channelOf("raced"))?.channel).toBe("channel-set-meanwhile");
    expect((await channelOf("after"))?.channel).toBe("channel-b");
  });
});
