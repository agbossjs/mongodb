import {
  ApplicationContext,
  EnvironmentField,
  Injectable,
  type OnDestroy,
  type OnInit,
} from "@agboss/core";
import {
  MongoClient,
  type ClientSession,
  type Db,
  type MongoClientOptions,
  type TransactionOptions,
} from "mongodb";
import { MongoSettingsError } from "../errors.js";
import {
  concernProblemsOf,
  enforcementProblemsOf,
  ENFORCED_CLIENT_OPTIONS,
  requireConcerns,
  transactionOptionsOf,
  TransactionReadConcern,
} from "./concerns.js";
import { requireTransactionalDeployment, type MongoTopology } from "./deployment.js";
import { ensureSchema } from "./schema.js";
import {
  databaseOfUrl,
  DEFAULT_DATABASE,
  settingsOfEnvironment,
  type MongoConnectionSettings,
} from "./settings.js";
import type { MongoTransaction } from "./transaction.js";

/** Each connection's start (`onInit`), made once: a component keeps no state of its own. */
const started = new WeakMap<MongoConnection, Promise<void>>();

/** A client of `url`: the driver parses it here and connects on the first operation only. */
function clientOf(url: string, options?: MongoClientOptions): MongoClient {
  try {
    return new MongoClient(url, options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MongoSettingsError(
      `mongodbUrl is not a usable MongoDB connection string: ${reason}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * The MongoDB deployment of one application instance: one `MongoClient` on the environment's
 * `mongodbUrl`, shared by every MongoDB store the application lists. Its client always writes with
 * `w=majority` on the journal and reads at `majority` from the primary; a URL that asks for less
 * fails with `MongoConcernTooWeakError` when the connection is built. At `onInit` it requires a
 * replica set (or a sharded cluster): a standalone `mongod` fails with
 * `MongoReplicaSetRequiredError`. At `onDestroy`, after its stores, it closes the client. Created
 * by the container (`deps: [ApplicationContext]`) or by a script or a test from its settings
 * (`new MongoConnection({ url })`). The DI token the MongoDB stores will name in their `deps`.
 */
@Injectable({
  deps: [ApplicationContext],
  // checked at the application's assembly (agbossjs/agboss#511): a contract without mongodbUrl
  // fails with [environment.missing-field] before anything starts
  environmentFields: {
    mongodbUrl: EnvironmentField.Secret,
    mongodbDatabase: EnvironmentField.OptionalText,
    mongodbTransactionReadConcern: EnvironmentField.OptionalText,
  },
})
export class MongoConnection implements OnInit, OnDestroy {
  /** The instance's client: every store's operations, every transaction's session. */
  readonly client: MongoClient;
  /** The database the stores' collections are in (`mongodbDatabase`, else the URL's, else `agboss`). */
  readonly db: Db;
  readonly #transactionOptions: TransactionOptions;

  constructor(source: ApplicationContext | MongoConnectionSettings) {
    const settings =
      source instanceof ApplicationContext ? settingsOfEnvironment(source.environment) : source;
    // what the URL alone asks for: a weaker concern there is refused, never silently overridden
    requireConcerns(concernProblemsOf(clientOf(settings.url)));
    // a field left `undefined` is left out, never written as `null`: a document reads back as given
    this.client = clientOf(settings.url, { ...ENFORCED_CLIENT_OPTIONS, ignoreUndefined: true });
    requireConcerns(enforcementProblemsOf(this.client));
    this.db = this.client.db(settings.database ?? databaseOfUrl(settings.url) ?? DEFAULT_DATABASE);
    this.#transactionOptions = transactionOptionsOf(
      settings.transactionReadConcern ?? TransactionReadConcern.Snapshot,
    );
  }

  /** The options every store transaction runs with (`inTransaction`). */
  get transactionOptions(): TransactionOptions {
    return this.#transactionOptions;
  }

  /**
   * The deployment the client reaches (`hello`): a replica set or a sharded cluster; a standalone
   * `mongod` rejects with `MongoReplicaSetRequiredError`.
   */
  async deployment(): Promise<MongoTopology> {
    return requireTransactionalDeployment(await this.db.admin().command({ hello: 1 }));
  }

  /** One `ping`: every MongoDB store's `ping()`. Rejects when the deployment does not answer. */
  async ping(): Promise<void> {
    await this.db.command({ ping: 1 });
  }

  /**
   * `work` in one transaction (`transactionOptions`: snapshot or majority reads, `w=majority`
   * commit) — the driver's `withTransaction`, with its retry rules, which the stores rely on:
   *
   * - an error labelled `TransientTransactionError` (a `WriteConflict` with another transaction, a
   *   primary stepping down before the commit) aborts the attempt — none of its writes is ever
   *   seen — and runs `work` again from its start, in a new transaction, until 120 s have passed;
   *   so `work` may run more than once per call and must do nothing outside `transaction.session`;
   * - a commit whose outcome is unknown (`UnknownTransactionCommitResult`: the reply lost, a write
   *   concern error) is committed again — the same transaction, which the server commits once —,
   *   never run again; past the 120 s the call rejects and the transaction may have committed, so
   *   a caller treats that rejection as "outcome unknown" and reads before it writes again;
   * - any other error (the work's own, a fence's refusal) aborts and is rethrown as it is.
   *
   * Each operation of `work` passes `{ session: transaction.session }`.
   */
  async inTransaction<TResult>(
    work: (transaction: MongoTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    const session: ClientSession = this.client.startSession();
    const transaction: MongoTransaction = { session, db: this.db };
    try {
      return await session.withTransaction(() => work(transaction), this.#transactionOptions);
    } finally {
      await session.endSession();
    }
  }

  /**
   * The start checks: the deployment is a replica set or a sharded cluster; then the stores'
   * collections and indexes, made if missing (a collection with another collation than the simple
   * one is `MongoCollationError`). Once per connection: a second call waits for the first.
   */
  onInit(): Promise<void> {
    const ready = started.get(this) ?? this.deployment().then(() => ensureSchema(this.db));
    started.set(this, ready);
    return ready;
  }

  /** Closes the client when the instance stops (its stores are destroyed first: they depend on it). */
  async onDestroy(): Promise<void> {
    await this.client.close();
  }
}
