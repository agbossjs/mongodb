import type { ClientSession, Collection, Db, Document } from "mongodb";
import { writeErrorOf } from "./outcome.js";

/**
 * Every single-command write of every store reads an ambiguous error as an unknown outcome
 * (agbossjs/agboss#1017, agbossjs/mongodb#76): the stores get their collections from this
 * database, so a store cannot forget the classification of a write it adds.
 *
 * A write method and the position of its options (where `session` is): the last argument of the
 * driver's signature.
 */
const WRITES: ReadonlyMap<string | symbol, number> = new Map([
  ["insertOne", 1],
  ["insertMany", 1],
  ["updateOne", 2],
  ["updateMany", 2],
  ["replaceOne", 2],
  ["deleteOne", 1],
  ["deleteMany", 1],
  ["findOneAndUpdate", 2],
  ["findOneAndReplace", 2],
  ["findOneAndDelete", 1],
  ["bulkWrite", 1],
]);

/** The writes of many documents: outside a transaction they are not atomic. */
const MANY: ReadonlySet<string | symbol> = new Set(["updateMany", "deleteMany"]);

/** Whether a write called with `options` is a command of an open transaction (its commit is read as unknown, not it). */
function inTransactionOf(options: unknown): boolean {
  if (typeof options !== "object" || options === null || !("session" in options)) return false;
  const session = options.session as ClientSession | undefined;
  return session?.inTransaction() === true;
}

function classifiedCollection<TDocument extends Document>(
  collection: Collection<TDocument>,
): Collection<TDocument> {
  return new Proxy(collection, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      const call = (args: unknown[]): unknown => Reflect.apply(member, target, args);
      const optionsAt = WRITES.get(property);
      if (optionsAt === undefined) return (...args: unknown[]) => call(args);
      return async (...args: unknown[]) => {
        // read BEFORE the call: a failed command may end the transaction, and the session says so after
        const inTransaction = inTransactionOf(args[optionsAt]);
        try {
          return await call(args);
        } catch (error) {
          if (inTransaction) throw error;
          const operation = `${target.collectionName}.${String(property)}`;
          throw writeErrorOf(operation, error, MANY.has(property));
        }
      };
    },
  });
}

/**
 * `db`, whose collections read an error of a write outside a transaction that leaves its outcome
 * unknown (`outcome.ts`) as `StoreOutcomeUnknownError`. A write of a transaction is left as it is:
 * its commit decides (`MongoConnection.inTransaction`); a read is never unknown.
 */
export function classifiedDb(db: Db): Db {
  return new Proxy(db, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      if (property === "collection")
        return <TDocument extends Document>(...args: Parameters<Db["collection"]>) =>
          classifiedCollection(target.collection<TDocument>(...args));
      return (...args: unknown[]): unknown => Reflect.apply(member, target, args);
    },
  });
}
