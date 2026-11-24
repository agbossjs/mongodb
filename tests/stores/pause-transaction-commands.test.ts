/**
 * agbossjs/agboss#1213: every operation of a pause transaction passes the transaction's session —
 * a command outside it is not undone when the transaction aborts and does not see the
 * transaction's own writes. Read from the commands the client sends (`autocommit: false`), for each
 * method of the store that runs in a transaction, and what the retention's and the heal's reads ask.
 */
import { NO_RECIPIENTS, PauseNoticeKind, type PauseRecipients } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collections, MongoPausedExecutionRepository } from "../../src/index.js";
import { fillMissingChannels } from "../../src/connection/pause-channels.js";
import { pauseIdOf, type PauseDocument } from "../../src/stores/paused/pause-documents.js";
import { commandsOf, nameOf, type Sent } from "../support/command-log.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { ANSWER, NINE, pauseOf } from "../support/pauses.js";
import { insertMailboxRow, insertTakenRow } from "../support/pause-rows.js";
import { connectionTo } from "../support/stores.js";

vi.mock("mongodb", async (importOriginal) => {
  const { reportingCommands } = await import("../support/command-log.js");
  return reportingCommands(await importOriginal());
});

const database = testDatabase();
const AUDIT: PauseRecipients = { listeners: ["audit"] };
const LATER = new Date(NINE.getTime() + 60_000);

beforeEach(() => emptyAll(database.url()));

const storeOn = (clock = new VirtualClock()) =>
  new MongoPausedExecutionRepository(connectionTo(database.url()), clock);

/** A store whose commands are logged, and the log. */
function watched(): { store: MongoPausedExecutionRepository; log: Sent[] } {
  const connection = connectionTo(database.url());
  const log = commandsOf(connection);
  return { store: new MongoPausedExecutionRepository(connection, new VirtualClock()), log };
}

/** The commands on the pauses and their mailboxes (the sequence counter is outside every transaction). */
const ofPauses = (log: readonly Sent[]): Sent[] =>
  log.filter(
    (one) => one.collection === Collections.Pauses || one.collection === Collections.PauseNotices,
  );

async function sentPause(id: string): Promise<void> {
  const store = storeOn();
  await store.findOrCreateByStepKey(pauseOf(id));
  await store.markSentByTenantIdAndPauseId("default", id, AUDIT);
}

const pauses = () => connectionTo(database.url()).db.collection<PauseDocument>(Collections.Pauses);
const PAUSES = Collections.Pauses;
const BOXES = Collections.PauseNotices;

describe("agbossjs/agboss#1213: a pause transaction's operations are in it", () => {
  it("the sent mark reads, marks and writes its notice in the transaction; a pause already sent writes nothing", async () => {
    await storeOn().findOrCreateByStepKey(pauseOf("p"));
    const { store, log } = watched();

    expect(await store.markSentByTenantIdAndPauseId("default", "p", AUDIT)).toBe(true);
    expect(ofPauses(log).map(nameOf)).toEqual([
      `find ${PAUSES}`,
      `update ${PAUSES}`,
      `update ${BOXES}`,
    ]);
    expect(ofPauses(log).every((one) => one.inTransaction)).toBe(true);

    log.length = 0;
    expect(await store.markSentByTenantIdAndPauseId("default", "p", AUDIT)).toBe(true);
    expect(log.map(nameOf)).toEqual([`find ${PAUSES}`]);
    expect(log.every((one) => one.inTransaction)).toBe(true);
  });

  it("the sent mark of a pause that is not stored is false", async () => {
    expect(await storeOn().markSentByTenantIdAndPauseId("default", "nobody", AUDIT)).toBe(false);
  });

  it("an answer reads the pause, records it and writes its notice in the transaction", async () => {
    await sentPause("p");
    const { store, log } = watched();

    await store.resolveByTenantIdAndPauseId("default", "p", ANSWER, LATER, AUDIT);

    expect(ofPauses(log).map(nameOf)).toEqual([
      `find ${PAUSES}`,
      `update ${PAUSES}`,
      `update ${BOXES}`,
    ]);
    expect(ofPauses(log).every((one) => one.inTransaction)).toBe(true);
  });

  it("a notice once reads the pause and the mailboxes, writes to the pause and appends, in the transaction", async () => {
    await sentPause("decoy");
    await sentPause("p");
    const { store, log } = watched();

    const facts = { expiresAt: LATER.toISOString(), previousExpiresAt: NINE.toISOString() };
    await store.noticeOnceByTenantIdAndPauseId(
      "default",
      "p",
      PauseNoticeKind.Extended,
      facts,
      LATER,
      AUDIT,
    );

    expect(ofPauses(log).map(nameOf)).toEqual([
      `find ${PAUSES}`,
      `find ${BOXES}`,
      `update ${PAUSES}`,
      `update ${BOXES}`,
    ]);
    expect(ofPauses(log).every((one) => one.inTransaction)).toBe(true);
    expect((await pauses().findOne({ pauseId: "p" }))?.noticeWrites).toBe(1);
    expect((await pauses().findOne({ pauseId: "decoy" }))?.noticeWrites).toBeUndefined();
  });

  it("a reassignment reads the pause and the tree's step keys (their keys only), writes both pauses and the notice, in the transaction", async () => {
    await sentPause("p");
    const { store, log } = watched();

    await store.reassignByTenantIdAndPauseId(
      "default",
      "p",
      { pauseId: "p-r", assignee: "alice" },
      LATER,
      AUDIT,
    );

    expect(ofPauses(log).map(nameOf)).toEqual([
      `find ${PAUSES}`,
      `find ${PAUSES}`,
      `update ${PAUSES}`,
      `update ${BOXES}`,
      `insert ${PAUSES}`,
    ]);
    expect(ofPauses(log).every((one) => one.inTransaction)).toBe(true);
    expect(ofPauses(log)[1]?.command).toMatchObject({
      filter: { tenantId: "default", rootExecutionId: "run-1" },
      projection: { stepKey: 1 },
    });
  });
});

/** p1 reassigned to p2 (kept while it is stored), p3 taken with a mailbox that is finished (removable). */
async function retentionRows(): Promise<void> {
  const store = storeOn();
  await store.findOrCreateByStepKey(pauseOf("p1"));
  await store.reassignByTenantIdAndPauseId(
    "default",
    "p1",
    { pauseId: "p2", assignee: "a" },
    NINE,
    NO_RECIPIENTS,
  );
  await insertTakenRow(connectionTo(database.url()).db, "p3", 9, NINE.toISOString());
  await insertMailboxRow(connectionTo(database.url()).db, "p3", {
    headWrittenAt: NINE,
    nextAttemptAt: NINE,
    isDead: true,
  });
  await insertMailboxRow(connectionTo(database.url()).db, "p1", {
    headWrittenAt: NINE,
    nextAttemptAt: NINE,
    isDead: true,
  });
}

describe("agbossjs/agboss#1213: the retention's transaction", () => {
  it("reads, looks up the replacements by id only, and deletes the pauses and the mailboxes, in the transaction", async () => {
    await retentionRows();
    const { store, log } = watched();

    await store.deleteByResolvedAtBefore(LATER);

    const first = ofPauses(log).slice(0, 6);
    expect(first.map(nameOf)).toEqual([
      `find ${PAUSES}`,
      `find ${BOXES}`,
      `find ${PAUSES}`,
      `find ${PAUSES}`,
      `delete ${PAUSES}`,
      `delete ${BOXES}`,
    ]);
    expect(ofPauses(log).every((one) => one.inTransaction)).toBe(true);
    expect(first[2]?.command).toMatchObject({
      filter: { _id: { $in: [pauseIdOf("default", "p2")] } },
      projection: { _id: 1 },
    });
  });

  it("only the removed pause's mailbox goes: a kept pause's mailbox stays", async () => {
    await retentionRows();

    await storeOn().deleteByResolvedAtBefore(LATER);

    const { db } = connectionTo(database.url());
    expect(await db.collection(Collections.Pauses).distinct("pauseId")).toEqual(["p1", "p2"]);
    expect(await db.collection(Collections.PauseNotices).distinct("pauseId")).toEqual(["p1"]);
  });

  it("a page of removable pauses stops reading at its limit", async () => {
    const { db } = connectionTo(database.url());
    await insertTakenRow(db, "a", 1, NINE.toISOString());
    await insertTakenRow(db, "b", 2, NINE.toISOString());
    const { store, log } = watched();

    const page = await store.findClosedByResolvedAtBefore(LATER, 1);

    expect(page.pauses.map((one) => one.pauseId)).toEqual(["a"]);
    // one read of the pauses, one of their mailboxes, one of their replacements: no second batch
    expect(log.map(nameOf)).toEqual([`find ${PAUSES}`, `find ${BOXES}`, `find ${PAUSES}`]);
  });
});

describe("agbossjs/agboss#1213: the channel heal reads the record only", () => {
  it("it asks for the pauses that lack a channel, and for their record", async () => {
    await storeOn().findOrCreateByStepKey(pauseOf("p"));
    const { db } = connectionTo(database.url());
    await db
      .collection(Collections.Pauses)
      .updateOne({ pauseId: "p" }, { $unset: { channel: "" } });
    const connection = connectionTo(database.url());
    const sent = commandsOf(connection);

    await fillMissingChannels(connection.db, {});

    expect(sent[0]?.command).toMatchObject({
      filter: { channel: null },
      projection: { record: 1 },
    });
    expect(await db.collection(Collections.Pauses).distinct("channel")).toEqual([
      "refund-approval-channel",
    ]);
  });
});
