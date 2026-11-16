import type { Db } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";
import { MongoLiveLeasesError } from "../errors.js";

/**
 * The execution leases live on the server's clock (agbossjs/agboss#1104, ADR-0034): `released`,
 * `finished` and `superseded` all `false` and `expiresAt` after `$$NOW` — one aggregation, so the
 * instant is the server's, bound once, never this process's clock. A seed document (a cancel before
 * the first acquire, #1117: token 0, released) and a lease closed by a check are not live.
 */
const HOLDERS_SHOWN = 5;

const Count = z.object({ count: z.number().int() });
const Holder = z.object({ _id: z.string() });

/** Throws `MongoLiveLeasesError` when an execution lease is live (the count and up to 5 holders), else nothing. */
export async function refuseLiveLeases(db: Db): Promise<void> {
  const live = {
    released: false,
    finished: false,
    superseded: false,
    $expr: { $gt: ["$expiresAt", "$$NOW"] },
  };
  const leases = db.collection(Collections.ExecutionLeases);
  const [counted] = await leases.aggregate([{ $match: live }, { $count: "count" }]).toArray();
  const count = counted === undefined ? 0 : Count.parse(counted).count;
  if (count === 0) return;
  const holders = await leases
    .aggregate([
      { $match: live },
      { $group: { _id: "$holderInstanceId" } },
      { $sort: { _id: 1 } },
      { $limit: HOLDERS_SHOWN },
    ])
    .toArray();
  throw new MongoLiveLeasesError({ count, holders: holders.map((one) => Holder.parse(one)._id) });
}
