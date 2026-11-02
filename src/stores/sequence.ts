import type { Db } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";

const Sequence = z.object({ value: z.number().int() });

/**
 * The next `count` numbers of the sequence `name` (its last one returned): one `$inc` of the
 * sequence's document, atomic and acknowledged by a majority, so two instances never draw one
 * number. What reads "in the order appended" orders by them — never by a client's clock or by an
 * `ObjectId`, whose time part is the inserting client's (agbossjs/agboss#661, #682). Drawn outside
 * any transaction (a transaction on a shared counter would conflict with every other); a number
 * drawn by a write that then found its key taken is a gap, never a second use.
 */
export async function nextSequence(db: Db, name: string, count = 1): Promise<number> {
  const drawn = await db
    .collection<{ _id: string; value: number }>(Collections.Sequences)
    .findOneAndUpdate(
      { _id: name },
      { $inc: { value: count } },
      { upsert: true, returnDocument: "after" },
    );
  return Sequence.parse(drawn).value;
}
