/**
 * agbossjs/agboss#1307 (P6b): the answer log's `askedAt` is a BSON Date in every entry (the order
 * `sort({ askedAt: 1, seq: 1 })` is by instant), its JSON canonical text, and an Invalid Date is
 * refused before a sequence is drawn or an entry written.
 */
import { StoreError } from "@agboss/core/stores";
import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  markPauseAnswerNotTaken,
  pauseAnswerTextsOf,
  savePauseAnswer,
} from "../../src/stores/records/record-writes.js";
import { answerOf } from "../support/pause-answers.js";
import { NINE } from "../support/pauses.js";

const BAD = new Date(Number.NaN);

/** A database that logs every `updateOne` and answers the sequence's counter. */
function database(): { db: Db; updates: unknown[][] } {
  const updates: unknown[][] = [];
  const collection = {
    findOneAndUpdate: () => Promise.resolve({ value: 1 }),
    updateOne: (...args: unknown[]) => {
      updates.push(args);
      return Promise.resolve({});
    },
  };
  return { db: { collection: () => collection } as never, updates };
}

const refusal = (field: string): Error =>
  new StoreError.UnreadableRecord({ record: "pause answer", fields: field });

describe("the pause answer log's times", () => {
  it("saves askedAt as the BSON Date it is and the entry's JSON with canonical texts", async () => {
    const { db, updates } = database();

    await savePauseAnswer(db, "default", "root", answerOf("manager-17"));

    const document = (updates[0]?.[1] as { $setOnInsert: { askedAt: Date; record: string } })
      .$setOnInsert;
    expect(document.askedAt).toStrictEqual(NINE);
    expect(JSON.parse(document.record)).toMatchObject({
      askedAt: "2026-01-05T09:00:00.000Z",
      resolvedAt: "2026-01-05T09:05:00.000Z",
    });
  });

  it("the not-taken entry keeps askedAt a Date too", async () => {
    const { db, updates } = database();

    await markPauseAnswerNotTaken(db, "default", "root", answerOf("manager-17"));

    expect(updates[0]?.[1]).toMatchObject({ $setOnInsert: { askedAt: NINE } });
  });

  it.each([
    ["askedAt", { askedAt: BAD }],
    ["resolvedAt", { resolvedAt: BAD }],
  ])("an Invalid Date in %s is refused and nothing is written", async (field, change) => {
    const { db, updates } = database();
    const answer = { ...answerOf("manager-17"), ...change };

    await expect(savePauseAnswer(db, "default", "root", answer)).rejects.toThrowError(
      refusal(field),
    );
    await expect(markPauseAnswerNotTaken(db, "default", "root", answer)).rejects.toThrowError(
      refusal(field),
    );
    expect(updates).toEqual([]);
  });

  it("an Invalid Date in the chain of custody is refused by its path", async () => {
    const { db, updates } = database();
    const answer = answerOf("manager-17");

    await expect(
      savePauseAnswer(db, "default", "root", {
        ...answer,
        trail: answer.trail.map((entry) => ({ ...entry, at: BAD })),
      }),
    ).rejects.toThrowError(refusal("trail[0].at"));
    expect(updates).toEqual([]);
  });

  it("an entry whose askedAt is a text is refused when the log is read, by the field, not the value", async () => {
    const cursor = {
      sort: () => cursor,
      toArray: () => Promise.resolve([{ record: "{}", askedAt: "2026-01-05T09:00:00.000Z" }]),
    };
    const db = { collection: () => ({ find: () => cursor }) } as never;

    const refused = await pauseAnswerTextsOf(db, "default", "root").then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(StoreError.UnreadableRecord);
    expect((refused as Error).message).toContain("askedAt");
    expect((refused as Error).message).not.toContain("2026-01-05");
  });
});
