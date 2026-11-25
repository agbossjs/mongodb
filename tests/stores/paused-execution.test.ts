import {
  ComponentKind,
  PauseKind,
  PauseResolution,
  PauseStatus,
  type PauseRecord,
} from "@agboss/core";
import { NO_RECIPIENTS } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Collections, MongoPausedExecutionRepository } from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { pauseOf as approvalOf } from "../support/pauses.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/agboss#746 on MongoDB: a question role's pause (#659 a flow step, #712 an agent's tool)
 * asks the role's own DTO, no tool call — it is kept and read back as written, on another instance
 * too; an approval's pause that lost its tool call still fails loudly.
 */
const database = testDatabase();
const NINE = new Date("2026-01-05T09:00:00.000Z");

const pausesOn = (): MongoPausedExecutionRepository =>
  new MongoPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());

const pauseOf = (pauseId: string, stepKey: string): PauseRecord => approvalOf(pauseId, stepKey);

/** The pause without its tool call: what a question's record is. */
const withoutToolCall = (pause: PauseRecord): PauseRecord =>
  Object.fromEntries(Object.entries(pause).filter(([key]) => key !== "toolCall")) as PauseRecord;

/** A question role's pause — the role its component, its input the role's DTO (the report's shape). */
const questionPauseOf = (pauseId: string, stepKey: string): PauseRecord => ({
  ...withoutToolCall(pauseOf(pauseId, stepKey)),
  nodeId: "ship-question",
  kind: PauseKind.ExternalTask,
  step: "ship-question",
  target: "ship-external-task",
  channel: "ship-question",
  component: {
    name: "ship-question",
    kind: ComponentKind.Question,
    promptHash: undefined,
    schemaHash: "ddb0c5dd",
  },
  input: { name: "box-1" },
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
  it("agbossjs/agboss#746: a question's pause, whose input is no tool call, is read back as written on another instance", async () => {
    const asked = questionPauseOf("p-question", "step-question");
    await pausesOn().findOrCreateByStepKey(asked);
    const other = pausesOn();

    await other.resolveByTenantIdAndPauseId(
      "default",
      "p-question",
      { decision: { verdict: "yes" }, actor: undefined },
      NINE,
      NO_RECIPIENTS,
    );

    expect(await other.findAllByTenantIdAndRootExecutionId("default", "run-1")).toEqual([
      expect.objectContaining({ pauseId: "p-question", input: { name: "box-1" } }),
    ]);
    expect(await pausesOn().findByTenantIdAndPauseId("default", "p-question")).toMatchObject({
      component: { kind: ComponentKind.Question },
      input: { name: "box-1" },
      status: PauseStatus.Resolved,
      resolution: PauseResolution.Replied,
      answer: { decision: { verdict: "yes" } },
    });
  });

  it("an approval's pause that lost its tool call still fails loudly when read", async () => {
    const pauses = pausesOn();
    await pauses.findOrCreateByStepKey(pauseOf("p-no-call", "step-no-call"));
    await editRecord("p-no-call", (record) =>
      Object.fromEntries(Object.entries(record).filter(([key]) => key !== "toolCall")),
    );

    await expect(pauses.findByTenantIdAndPauseId("default", "p-no-call")).rejects.toThrow(
      /a stored pause is not readable/,
    );
  });

  it("agbossjs/agboss#801: an approval's pause asks a tool call: a question's input on it fails loudly", async () => {
    const pauses = pausesOn();
    await pauses.findOrCreateByStepKey(questionPauseOf("p-unkinded", "step-unkinded"));
    await editRecord("p-unkinded", (record) => ({ ...record, kind: PauseKind.Approval }));

    await expect(pauses.findByTenantIdAndPauseId("default", "p-unkinded")).rejects.toThrow(
      /a stored pause is not readable/,
    );
  });

  it("a question's pause whose input is not an object fails loudly when read", async () => {
    const pauses = pausesOn();
    await pauses.findOrCreateByStepKey(questionPauseOf("p-text-ask", "step-text-ask"));
    await editRecord("p-text-ask", (record) => ({ ...record, input: "box-1" }));

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
      kind: PauseKind.ExternalTask,
      input: { name: "box-1" },
    });
  });
});
