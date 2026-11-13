/**
 * agbossjs/agboss#938 AC1 — a change and its notices land together or not at all. The contract
 * cases read only what a store answers, so they cannot see a commit split in two; this test forces
 * the server to refuse the transaction's commit (the `failCommand` fail point: the process dies
 * between the writes and the commit) and reads the collections after. The second test is the same
 * run on a store that writes its outbox outside the session: it leaves the notice — the check bites.
 */
import { VirtualClock } from "@agboss/core/testing";
import { PauseStatus } from "@agboss/core";
import type { PauseRecipients } from "@agboss/core/stores";
import { MongoClient, type Document } from "mongodb";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MongoPausedExecutionRepository, type MongoConnection } from "../../src/index.js";
import { mailboxIdOf, mailboxesOf } from "../../src/stores/paused/pause-mailboxes.js";
import { openConnection, testDatabase } from "../support/database.js";
import { ANSWER, NINE, pauseOf } from "../support/pauses.js";
import { OutsideSessionOutbox } from "./pause-sabotage.js";

const APP = "agboss-pause-atomic-test";
const AUDIT: PauseRecipients = { listeners: ["audit"] };
const database = testDatabase();
let connection: MongoConnection;
let admin: MongoClient;

beforeAll(async () => {
  // the fail point names this client by its appName: the other files' clients never fail
  connection = await openConnection(`${database.url()}&appName=${APP}`);
  admin = new MongoClient(database.url());
});

afterEach(async () => {
  await admin.db("admin").command({ configureFailPoint: "failCommand", mode: "off" });
});

afterAll(async () => {
  // a commit the server refused leaves its transaction open until the server's own timeout (the
  // driver does not abort a failed commit): end it, or the file's database cannot be dropped
  await admin.db("admin").command({ killAllSessions: [] });
  await connection.onDestroy();
  await admin.close();
});

/** Makes the next commit of this test's client fail with a code the driver does not retry. */
async function failNextCommit(data: Document): Promise<void> {
  await admin.db("admin").command({
    configureFailPoint: "failCommand",
    mode: { times: 1 },
    data: { failCommands: ["commitTransaction"], appName: APP, ...data },
  });
}

type Make = new (
  ...args: ConstructorParameters<typeof MongoPausedExecutionRepository>
) => MongoPausedExecutionRepository;

/** A sent pause `id` answered while the commit is killed: what the collections hold after. */
async function answeredWithCommitKilled(Store: Make, id: string) {
  const store = new Store(connection, new VirtualClock());
  await store.findOrCreateByStepKey(pauseOf(id));
  await store.markSentByTenantIdAndPauseId("default", id, { listeners: [] });
  await failNextCommit({ errorCode: 2 });

  const outcome = store.resolveByTenantIdAndPauseId("default", id, ANSWER, NINE, AUDIT);

  await expect(outcome).rejects.toThrow();
  return {
    status: (await store.findByTenantIdAndPauseId("default", id))?.status,
    notices: await mailboxesOf(connection.db).countDocuments({
      _id: mailboxIdOf("default", id, "listener:audit"),
    }),
  };
}

describe("a change and its notices are one transaction", () => {
  it("a commit that fails leaves the pause Pending and writes no notice", async () => {
    const after = await answeredWithCommitKilled(MongoPausedExecutionRepository, "p-atomic");

    expect(after).toEqual({ status: PauseStatus.Pending, notices: 0 });
  });

  it("sabotage: with the outbox written outside the session, a failed commit leaves the notice behind", async () => {
    const after = await answeredWithCommitKilled(OutsideSessionOutbox, "p-outside");

    expect(after).toEqual({ status: PauseStatus.Pending, notices: 1 });
  });
});
