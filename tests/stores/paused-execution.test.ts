import {
  ComponentKind,
  PauseAnswerer,
  PauseKind,
  PauseResolution,
  questionAskOf,
  PauseStatus,
  type PauseRecord,
} from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Collections, MongoPausedExecutionRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#746 on MongoDB: a question role's pause (#659 a flow step, #712 an agent's tool)
 * asks the role's own DTO, no tool call — it is kept and read back as written, on another instance
 * too; an approval's pause whose ask lost its tool call still fails loudly.
 */
const database = testDatabase();
const NINE = new Date("2026-01-05T09:00:00.000Z");

const pausesOn = (): MongoPausedExecutionRepository =>
  new MongoPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());

const pauseOf = (pauseId: string, stepKey: string): PauseRecord => ({
  pauseId,
  tenantId: "default",
  threadId: "thread-1",
  rootExecutionId: "run-1",
  executionId: "run-1",
  workflow: "order-workflow",
  stepKey,
  nodeId: "clerk-agent",
  visitNumber: 1,
  itemIndex: undefined,
  copyNumber: 1,
  kind: PauseKind.Approval,
  step: "clerk-agent",
  channel: "refund-approval-channel",
  answerer: PauseAnswerer.Channel,
  ask: { callId: "call-1", tool: "charge", arguments: { text: "10 USD" }, summary: "charge" },
  status: PauseStatus.Pending,
  isSent: false,
  askedAt: "2026-01-05T09:00:00.000Z",
});

/** A question role's pause — the role its component, its ask the role's DTO (the report's shape). */
const questionPauseOf = (pauseId: string, stepKey: string): PauseRecord => ({
  ...pauseOf(pauseId, stepKey),
  nodeId: "ship-question",
  kind: PauseKind.Question,
  step: "ship-question",
  channel: "ship-question",
  component: {
    name: "ship-question",
    kind: ComponentKind.Question,
    promptHash: undefined,
    schemaHash: "ddb0c5dd",
  },
  ask: questionAskOf({ name: "box-1" }),
});

/** Rewrites the stored record of `pauseId` with `edit` — a document no store write makes. */
async function editRecord(
  pauseId: string,
  edit: (record: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const { db } = connectionTo(database.url());
  const pauses = db.collection<{ _id: string; pauseId: string; record: string }>(
    Collections.Pauses,
  );
  const found = await pauses.findOne({ pauseId });
  if (found === null) throw new Error(`no pause ${pauseId}`);
  const record = edit(z.record(z.string(), z.unknown()).parse(JSON.parse(found.record)));
  await pauses.updateOne({ _id: found._id }, { $set: { record: JSON.stringify(record) } });
}

describe("MongoPausedExecutionRepository", () => {
  it("agbossjs/agboss#746: a question's pause, whose ask is no tool call, is read back as written on another instance", async () => {
    const asked = questionPauseOf("p-question", "step-question");
    await pausesOn().findOrCreateByStepKey(asked);
    const other = pausesOn();

    await other.resolveByTenantIdAndPauseId(
      "default",
      "p-question",
      { decision: { verdict: "yes" }, answeredBy: undefined },
      NINE,
    );

    expect(await other.findAllByTenantIdAndRootExecutionId("default", "run-1")).toEqual([
      expect.objectContaining({ pauseId: "p-question", ask: { name: "box-1" } }),
    ]);
    expect(await pausesOn().findByTenantIdAndPauseId("default", "p-question")).toMatchObject({
      component: { kind: ComponentKind.Question },
      ask: { name: "box-1" },
      status: PauseStatus.Resolved,
      resolution: PauseResolution.Replied,
      answer: { decision: { verdict: "yes" } },
    });
  });

  it("an approval's pause whose ask lost its tool call still fails loudly when read", async () => {
    const pauses = pausesOn();
    await pauses.findOrCreateByStepKey(pauseOf("p-no-call", "step-no-call"));
    await editRecord("p-no-call", (record) => ({
      ...record,
      ask: { tool: "charge", arguments: { text: "10 USD" }, summary: "charge" },
    }));

    await expect(pauses.findByTenantIdAndPauseId("default", "p-no-call")).rejects.toThrow(
      /a stored pause is not readable/,
    );
  });

  it("agbossjs/agboss#801: an approval's pause asks a tool call: a question's ask on it fails loudly", async () => {
    const pauses = pausesOn();
    await pauses.findOrCreateByStepKey(questionPauseOf("p-unkinded", "step-unkinded"));
    await editRecord("p-unkinded", (record) => ({ ...record, kind: PauseKind.Approval }));

    await expect(pauses.findByTenantIdAndPauseId("default", "p-unkinded")).rejects.toThrow(
      /a stored pause is not readable/,
    );
  });

  it("a question's pause whose ask is not an object fails loudly when read", async () => {
    const pauses = pausesOn();
    await pauses.findOrCreateByStepKey(questionPauseOf("p-text-ask", "step-text-ask"));
    await editRecord("p-text-ask", (record) => ({ ...record, ask: "box-1" }));

    await expect(pauses.findByTenantIdAndPauseId("default", "p-text-ask")).rejects.toThrow(
      /a stored pause is not readable/,
    );
  });

  it("agbossjs/agboss#801: a stored kind is read as written — a question whose component is an agent's stays a question", async () => {
    const pauses = pausesOn();
    await pauses.findOrCreateByStepKey(questionPauseOf("p-kept", "step-kept"));
    await editRecord("p-kept", (record) => ({
      ...record,
      component: { name: "clerk-agent", kind: ComponentKind.Agent },
    }));

    expect(await pauses.findByTenantIdAndPauseId("default", "p-kept")).toMatchObject({
      kind: PauseKind.Question,
      ask: { name: "box-1" },
    });
  });

  it("agbossjs/agboss#801: a record written before (agent, no kind) is read by the rule it was written under", async () => {
    const pauses = pausesOn();
    const before = (record: Record<string, unknown>): Record<string, unknown> => {
      const { step, ...rest } = record;
      const kept = Object.entries(rest).filter(([field]) => field !== "kind");
      return { ...Object.fromEntries(kept), agent: step };
    };
    await pauses.findOrCreateByStepKey(pauseOf("p-old-approval", "step-old-approval"));
    await pauses.findOrCreateByStepKey(questionPauseOf("p-old-question", "step-old-question"));
    await editRecord("p-old-approval", before);
    await editRecord("p-old-question", before);

    expect(await pauses.findByTenantIdAndPauseId("default", "p-old-approval")).toEqual(
      pauseOf("p-old-approval", "step-old-approval"),
    );
    expect(await pauses.findByTenantIdAndPauseId("default", "p-old-question")).toEqual(
      questionPauseOf("p-old-question", "step-old-question"),
    );
  });
});
