import { z } from "zod";
import { MongoSettingsError } from "../errors.js";
import { TransactionReadConcern } from "./concerns.js";

/** The database the stores use when the environment does not set `mongodbDatabase`. */
export const DEFAULT_DATABASE = "agboss";

/** What one application instance's connection is made of. */
export interface MongoConnectionSettings {
  /** The replica set: `mongodb://host1,host2,host3/?replicaSet=rs0` (or `mongodb+srv://…`). */
  readonly url: string;
  /** The database the stores' collections are in (default `agboss`). */
  readonly database?: string;
  /** The read concern of the stores' transactions (default `snapshot`). */
  readonly transactionReadConcern?: TransactionReadConcern;
}

/** A `Secret` of the environment: only `reveal()` gives its value. */
interface RevealedSecret {
  reveal(): string;
}

const isSecret = (value: unknown): value is RevealedSecret =>
  typeof value === "object" &&
  value !== null &&
  "reveal" in value &&
  typeof value.reveal === "function";

/** The fields the MongoDB stores read from the application's environment. */
const MongoEnvironment = z.object({
  mongodbUrl: z.custom<RevealedSecret>(isSecret, {
    message: 'mongodbUrl must be a Secret: mongodbUrl: secret("MONGODB_URL")',
  }),
  mongodbDatabase: z
    .string({ message: "mongodbDatabase must be a text" })
    .min(1, "mongodbDatabase is empty")
    .optional(),
  mongodbTransactionReadConcern: z
    .enum(TransactionReadConcern, {
      message: "mongodbTransactionReadConcern must be snapshot or majority",
    })
    .optional(),
});

const MISSING_URL =
  'mongodbUrl is missing: declare mongodbUrl!: Secret in the environment contract and set mongodbUrl: secret("MONGODB_URL")';

/**
 * The connection settings an application's environment gives: `mongodbUrl` (required, a
 * `Secret`), `mongodbDatabase` and `mongodbTransactionReadConcern` (optional). A missing or
 * mistyped field fails with `MongoSettingsError`, naming it — the URL itself is never printed.
 */
export function settingsOfEnvironment(environment: unknown): MongoConnectionSettings {
  const parsed = MongoEnvironment.safeParse(environment);
  if (!parsed.success) {
    const isUrlMissing = Reflect.get(Object(environment), "mongodbUrl") === undefined;
    const problems = parsed.error.issues.map((issue) =>
      issue.path[0] === "mongodbUrl" && isUrlMissing ? MISSING_URL : issue.message,
    );
    throw new MongoSettingsError(
      `the MongoDB stores need their environment fields — ${problems.join("; ")}`,
    );
  }
  const { mongodbUrl, mongodbDatabase, mongodbTransactionReadConcern } = parsed.data;
  const url = mongodbUrl.reveal();
  if (url.length === 0) throw new MongoSettingsError("mongodbUrl is empty");
  return {
    url,
    database: mongodbDatabase,
    transactionReadConcern: mongodbTransactionReadConcern,
  };
}
