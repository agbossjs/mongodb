/**
 * agbossjs/mongodb#99: the counter behind every `seq` (agbossjs/agboss#661, #682), on a real
 * server: one `$inc` of a document of its own, the number it left returned.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Collections, type MongoConnection } from "../../src/index.js";
import { nextSequence } from "../../src/stores/sequence.js";
import { emptyAll, openConnection, testDatabase } from "../support/database.js";

const database = testDatabase();
let connection: MongoConnection;

beforeAll(async () => {
  connection = await openConnection(database.url());
});

afterAll(async () => {
  await connection.onDestroy();
});

beforeEach(() => emptyAll(database.url()));

const documents = () =>
  connection.db.collection<{ _id: string; value: number }>(Collections.Sequences);

describe("nextSequence", () => {
  it("the first draw of a name is 1, and its document is made by it", async () => {
    expect(await nextSequence(connection.db, "calls")).toBe(1);

    expect(await documents().find().toArray()).toEqual([{ _id: "calls", value: 1 }]);
  });

  it("every draw is one more than the one before", async () => {
    const drawn = [
      await nextSequence(connection.db, "calls"),
      await nextSequence(connection.db, "calls"),
      await nextSequence(connection.db, "calls"),
    ];

    expect(drawn).toEqual([1, 2, 3]);
  });

  it("a draw of `count` numbers returns the last of them, and the next draw follows it", async () => {
    expect(await nextSequence(connection.db, "calls", 5)).toBe(5);
    expect(await nextSequence(connection.db, "calls", 3)).toBe(8);

    expect(await nextSequence(connection.db, "calls")).toBe(9);
    expect(await documents().findOne({ _id: "calls" })).toEqual({ _id: "calls", value: 9 });
  });

  it("each name counts on its own: a draw of one never moves another", async () => {
    expect(await nextSequence(connection.db, "calls")).toBe(1);
    expect(await nextSequence(connection.db, "calls")).toBe(2);
    expect(await nextSequence(connection.db, "pauses", 10)).toBe(10);
    expect(await nextSequence(connection.db, "calls")).toBe(3);

    const all = await documents().find().sort({ _id: 1 }).toArray();
    expect(all).toEqual([
      { _id: "calls", value: 3 },
      { _id: "pauses", value: 10 },
    ]);
  });

  it("a name that has a document continues it", async () => {
    await documents().insertOne({ _id: "calls", value: 40 });

    expect(await nextSequence(connection.db, "calls")).toBe(41);
  });

  it("calls made at once draw each a number of its own, never one twice", async () => {
    const drawn = await Promise.all(
      Array.from({ length: 20 }, () => nextSequence(connection.db, "calls")),
    );

    expect([...drawn].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("a stored value that is not a whole number is refused, never returned", async () => {
    await documents().insertOne({ _id: "calls", value: 1.5 });

    await expect(nextSequence(connection.db, "calls")).rejects.toThrow();
  });
});
