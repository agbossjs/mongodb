/**
 * agbossjs/mongodb#103/#104: the direct message's document and its reading, on records and documents
 * given by hand (no server): which optional fields are written and read, when the state and the reply
 * of a document disagree, what an unreadable reply names.
 */
import { A2ADirectMessageState, type A2ADirectMessageRecord } from "@agboss/core/stores";
import { describe, expect, it } from "vitest";
import {
  directDocumentOf,
  directIdOf,
  directMessageOf,
  replyTextOf,
} from "../../src/stores/a2a-direct-messages/a2a-direct-message-documents.js";

const NINE = new Date("2026-01-05T09:00:00.000Z");
const LATER = new Date("2026-01-05T09:00:30.000Z");
const REPLY = { finish: "quote-workflow-finish", output: { text: "ok" }, spentUsd: 0.01 };

const record = (extra: Partial<A2ADirectMessageRecord> = {}): A2ADirectMessageRecord => ({
  tenantId: "acme",
  ownerId: "alice",
  messageId: "m-1",
  requestHash: "h-1",
  skill: "quote",
  contextId: "ctx-1",
  state: A2ADirectMessageState.InFlight,
  attemptId: "run-1",
  startedAt: NINE,
  expiresAt: LATER,
  callsModel: true,
  createdAt: NINE,
  ...extra,
});

/** The document of `record(extra)` as the store keeps it. */
const documentOf = (extra: Partial<A2ADirectMessageRecord> = {}) => directDocumentOf(record(extra));

describe("directDocumentOf: an optional field is written when the record has it, and only then", () => {
  it("none of the four: the document has exactly its mandatory fields", () => {
    expect(Object.keys(documentOf()).sort()).toEqual(
      [
        "_id",
        "attemptId",
        "callsModel",
        "contextId",
        "createdAt",
        "expiresAt",
        "messageId",
        "ownerId",
        "requestHash",
        "skill",
        "startedAt",
        "state",
        "tenantId",
      ].sort(),
    );
  });

  it("each of the four, alone, is the one extra field, as it was given", () => {
    expect(documentOf({ callerPeer: "peer-1" })).toMatchObject({ callerPeer: "peer-1" });
    expect(documentOf({ meshBodyHash: "b-1" })).toMatchObject({ meshBodyHash: "b-1" });
    expect(documentOf({ reply: REPLY })).toMatchObject({ reply: replyTextOf(REPLY) });
    expect(documentOf({ completedAt: LATER })).toMatchObject({ completedAt: LATER });
    for (const [field, extra] of [
      ["callerPeer", { meshBodyHash: "b-1" }],
      ["meshBodyHash", { callerPeer: "peer-1" }],
      ["reply", { completedAt: LATER }],
      ["completedAt", { reply: REPLY }],
    ] as const)
      expect(documentOf(extra)).not.toHaveProperty(field);
  });

  it("the id is the key's, an absent owner is the empty text, the reply is its JSON text", () => {
    const document = documentOf({ ownerId: undefined, reply: REPLY, completedAt: LATER });

    expect(document._id).toBe(directIdOf(record({ ownerId: undefined })));
    expect(document.ownerId).toBe("");
    expect(JSON.parse(document.reply ?? "")).toEqual(REPLY);
  });
});

describe("directMessageOf: a document is read back as the record it was written from", () => {
  const completed = { state: A2ADirectMessageState.Completed, reply: REPLY, completedAt: LATER };

  it("every field of an in-flight message, optional ones included", () => {
    const written = record({ callerPeer: "peer-1", meshBodyHash: "b-1" });

    expect(directMessageOf(directDocumentOf(written))).toStrictEqual(written);
  });

  it("a completed one with its reply and its time", () => {
    const written = record(completed);

    expect(directMessageOf(directDocumentOf(written))).toStrictEqual(written);
  });

  it("no optional field in the document is none in the record, not an undefined one", () => {
    const read = directMessageOf(documentOf());

    for (const field of ["callerPeer", "meshBodyHash", "reply", "completedAt"])
      expect(read).not.toHaveProperty(field);
  });

  it("an empty owner is no owner", () => {
    expect(directMessageOf(documentOf({ ownerId: undefined })).ownerId).toBeUndefined();
  });

  it.each([
    ["a completed message with no reply and no time", { state: A2ADirectMessageState.Completed }],
    [
      "a completed message with a reply and no time",
      { state: A2ADirectMessageState.Completed, reply: REPLY },
    ],
    [
      "a completed message with a time and no reply",
      { state: A2ADirectMessageState.Completed, completedAt: LATER },
    ],
    ["an in-flight message with a reply and a time", { reply: REPLY, completedAt: LATER }],
    ["an in-flight message with a reply alone", { reply: REPLY }],
    ["an in-flight message with a time alone", { completedAt: LATER }],
  ])("%s: its state and its reply disagree, naming the message", (_name, extra) => {
    let thrown: unknown;
    try {
      directMessageOf(documentOf(extra));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'agboss_a2a_direct_messages "m-1": its state and its reply disagree',
    );
  });

  it("a reply that is not JSON is unreadable, naming what it is and the message, never its text", () => {
    const document = { ...documentOf(completed), reply: "{not json: secret-text" };

    const failure = (): unknown => directMessageOf(document);

    expect(failure).toThrow("a2a direct message reply");
    expect(failure).toThrow("m-1");
    expect(failure).not.toThrow("secret-text");
  });
});
