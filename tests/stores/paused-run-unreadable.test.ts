import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { Collections, MongoPausedExecutionRepository } from "../../src/index.js";
import { idOf } from "../../src/stores/keys.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#906 D4: a paused run stored by 0.1.0 names its record `ternId` — read as
 * `turnId` (as the SQLite store does); a stored run that cannot be read is refused by its ids and
 * the field that failed, the schema's error its `cause` — never with the run in the message, whose
 * `startInput` and `data` are the caller's (PII reaches the logs through a message).
 */
const database = testDatabase();
const SECRET = "ssn-078-05-1120";

const pausesOn = (): MongoPausedExecutionRepository =>
  new MongoPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());

const run = {
  status: "paused",
  threadId: "thread-1",
  tenantId: "acme",
  runId: "run-1",
  turnId: "turn-1",
  budgetUsd: 1,
  startInput: { ssn: SECRET },
  data: { note: SECRET },
};

interface StoredPaused {
  readonly _id: string;
  readonly runId: string;
  readonly run: string;
  readonly workflowVersion: string;
  readonly configHash: string;
  readonly pausedAt: Date;
}

/** The thread's stored run as `edit` makes it of `run` — a document no store write makes. */
async function storedAs(edit: (stored: Record<string, unknown>) => Record<string, unknown>) {
  const { db } = connectionTo(database.url());
  await db.collection<StoredPaused>(Collections.PausedExecutions).replaceOne(
    { _id: idOf("acme", "thread-1") },
    {
      runId: "run-1",
      run: JSON.stringify(edit({ ...run })),
      workflowVersion: "1.0.0",
      configHash: "hash",
      pausedAt: new Date(0),
    },
    { upsert: true },
  );
}

const failureOf = async (): Promise<Error> => {
  const thrown: unknown = await pausesOn()
    .findByTenantIdAndThreadId("acme", "thread-1")
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(thrown).toBeInstanceOf(Error);
  return thrown as Error;
};

describe("agbossjs/agboss#906 D4: MongoDB paused runs", () => {
  it("a run stored by 0.1.0 under `ternId` is read as `turnId`, and resumes from there", async () => {
    await storedAs(({ turnId, ...rest }) => ({ ...rest, ternId: turnId }));

    const found = await pausesOn().findByTenantIdAndThreadId("acme", "thread-1");

    expect(found?.run).toMatchObject({ turnId: "turn-1", runId: "run-1", tenantId: "acme" });
    expect(found?.run).not.toHaveProperty("ternId");
  });

  it("a run without any record id is refused by ids and field: the message carries no input value", async () => {
    await storedAs((stored) =>
      Object.fromEntries(Object.entries(stored).filter(([key]) => key !== "turnId")),
    );

    const error = await failureOf();

    expect(error.message).toContain("a stored paused run is not readable");
    expect(error.message).not.toContain("tenantId");
    expect(error.message).toContain("threadId thread-1");
    expect(error.message).toContain("runId run-1");
    expect(error.message).toContain("the field(s) turnId");
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain("startInput");
  });

  it("another failing field is named, and the schema's error is the cause", async () => {
    await storedAs((stored) => ({ ...stored, status: "answered" }));

    const error = await failureOf();

    expect(error.message).toContain("the field(s) status");
    expect(error.message).not.toContain(SECRET);
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).not.toContain(SECRET);
  });
});
