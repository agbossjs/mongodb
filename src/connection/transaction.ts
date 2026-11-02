import type { ClientSession, Db } from "mongodb";

/**
 * One store transaction as its work gets it (`MongoConnection.inTransaction`, the fenced effect's
 * work): its session — every operation of the work passes `{ session }`, else it is outside the
 * transaction and outside the guarantee — and the stores' database.
 */
export interface MongoTransaction {
  readonly session: ClientSession;
  readonly db: Db;
}
