/**
 * agbossjs/agboss#81: the pipeline of the child queue's change stream (`QUEUED_CHANGES`), run on
 * the real server: a change that queues a child — inserted queued, replaced by a queued document,
 * or updated to `queued` — is heard, and only its id leaves the server; a child inserted running,
 * an update of anything but the status, a claim (`running`) and a delete are not heard. Each
 * stage and each condition of it is one the stream does not work without.
 */
import { ExecutionRecordStatus } from "@agboss/core";
import type { ChangeStream } from "mongodb";
import { afterEach, describe, expect, it } from "vitest";
import { Collections } from "../../src/index.js";
import { QUEUED_CHANGES } from "../../src/stores/queue-changes.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();
const QUEUE = Collections.ChildExecutionQueue;
const streams: ChangeStream[] = [];

afterEach(async () => {
  for (const stream of streams.splice(0)) await stream.close();
});

interface Row {
  _id: string;
  status: string;
  depth?: number;
}

const rows = () => connectionTo(database.url()).db.collection<Row>(QUEUE);

describe("agbossjs/agboss#81: what the child queue's stream hears", () => {
  it("hears each change that queues a child, by its id alone, and nothing else", async () => {
    const stream = rows().watch(QUEUED_CHANGES, { maxAwaitTimeMS: 200 });
    streams.push(stream);
    await stream.tryNext();
    const { Queued, Running } = ExecutionRecordStatus;
    const heard: unknown[] = [];

    // not heard: a child inserted running, a plain update of a queued one, a claim, a delete
    await rows().insertOne({ _id: "running-new", status: Running });
    await rows().insertOne({ _id: "kept", status: Queued, depth: 1 });
    await rows().updateOne({ _id: "kept" }, { $set: { depth: 2 } });
    await rows().updateOne({ _id: "kept" }, { $set: { status: Running } });
    await rows().deleteOne({ _id: "running-new" });
    // heard: inserted queued, updated to queued, replaced by a queued document
    await rows().insertOne({ _id: "inserted", status: Queued });
    await rows().updateOne({ _id: "kept" }, { $set: { status: Queued } });
    await rows().replaceOne({ _id: "kept" }, { status: Running });
    await rows().replaceOne({ _id: "kept" }, { status: Queued });
    await rows().insertOne({ _id: "end", status: Running });
    await rows().insertOne({ _id: "last", status: Queued });

    // every write above is acknowledged by a majority: its change is there to be read
    for (let quiet = 0; quiet < 2;) {
      const next = await stream.tryNext();
      if (next === null) quiet += 1;
      else heard.push(next);
    }

    // five: the id of each change that queued a child (a resume token), and nothing of its document
    expect(heard).toHaveLength(5);
    expect(heard.map((event) => Object.keys(event as object))).toEqual(heard.map(() => ["_id"]));
  }, 30_000);
});
