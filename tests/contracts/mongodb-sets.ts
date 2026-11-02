import { FencedEffectSettings } from "@agboss/core";
import type { FencedEffectStores, StoreSeam } from "@agboss/core/testing/contracts";
import {
  MongoExecutionLeaseRepository,
  MongoFencedEffectRepository,
  type MongoConnection,
  type MongoTransaction,
} from "../../src/index.js";

/** The collection of the business rows a contract case's fenced effect writes. */
export const CONTRACT_ROWS = "contract_rows";

/** How many business rows this process inserted: the order they are read back in. */
let inserted = 0;

/**
 * The fenced-effect set of one instance (#500): the effect and lease stores, and the work's
 * business rows — inserted with the transaction's session, read back through the instance's client
 * (majority reads: what another connection sees committed), in the order inserted.
 */
export function fencedEffectsOn(
  connection: MongoConnection,
  seam: StoreSeam,
  effects = new MongoFencedEffectRepository(
    connection,
    seam.storeClock,
    new FencedEffectSettings(),
  ),
): FencedEffectStores<MongoTransaction> {
  const rows = connection.db.collection<{ row: string; at: number }>(CONTRACT_ROWS);
  return {
    effects,
    leases: new MongoExecutionLeaseRepository(connection, seam.storeClock, seam.application),
    rows: {
      insert: async ({ session }, row) => {
        inserted += 1;
        await rows.insertOne({ row, at: inserted }, { session });
      },
      committed: async () =>
        (await rows.find().sort({ at: 1 }).toArray()).map((found) => found.row),
    },
  };
}
