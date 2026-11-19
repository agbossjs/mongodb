/**
 * agbossjs/agboss#1213: the scans ask the server for their order — the claim for the mailbox due the
 * longest, the set-aside for the oldest head, the re-send scan for the key of its index — so the order
 * holds whichever plan the server chooses, read from the commands the client sends.
 */
import { seconds } from "@agboss/core/units";
import { VirtualClock } from "@agboss/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MongoPausedExecutionRepository } from "../../src/index.js";
import { commandsOf, type Sent } from "../support/command-log.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { NINE } from "../support/pauses.js";
import { connectionTo } from "../support/stores.js";

vi.mock("mongodb", async (importOriginal) => {
  const { reportingCommands } = await import("../support/command-log.js");
  return reportingCommands(await importOriginal());
});

const database = testDatabase();

beforeEach(() => emptyAll(database.url()));

/** The sort a command asked for, keys in order (the driver sends a Map). */
const sortOf = (sent: Sent | undefined): unknown[] => {
  const { sort }: { sort?: unknown } = sent?.command ?? {};
  if (sort instanceof Map) return [...sort];
  return typeof sort === "object" && sort !== null ? Object.entries(sort) : [];
};

function watched() {
  const connection = connectionTo(database.url());
  const log = commandsOf(connection);
  return { store: new MongoPausedExecutionRepository(connection, new VirtualClock()), log };
}

describe("agbossjs/agboss#1213: the order a scan asks for", () => {
  it("the claim asks for the oldest due first", async () => {
    const { store, log } = watched();

    await store.claimNoticesDue(NINE, 1, seconds(30), ["listener:audit"]);

    expect(sortOf(log[0])).toEqual([["nextAttemptAt", 1]]);
  });

  it("the set-aside asks for the oldest head first", async () => {
    const { store, log } = watched();

    await store.setAsideStaleNoticesBefore(NINE, NINE, "stale", 1);

    expect(sortOf(log[0])).toEqual([["headWrittenAt", 1]]);
  });

  it("the re-send scan asks for its index's key", async () => {
    const { store, log } = watched();

    await store.findPendingUnsentReassignedBefore(NINE, 5);

    expect(sortOf(log[0])).toEqual([
      ["askedAt", 1],
      ["tenantId", 1],
      ["pauseId", 1],
    ]);
  });
});
