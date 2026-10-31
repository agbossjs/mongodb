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
import {
  DEFAULT_DATABASE,
  settingsOfEnvironment,
  type MongoConnectionSettings,
} from "./settings.js";

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
  /** The database the stores' collections are in (`mongodbDatabase`, default `agboss`). */
  readonly db: Db;
  readonly #transactionOptions: TransactionOptions;

  constructor(source: ApplicationContext | MongoConnectionSettings) {
    const settings =
      source instanceof ApplicationContext ? settingsOfEnvironment(source.environment) : source;
    // what the URL alone asks for: a weaker concern there is refused, never silently overridden
    requireConcerns(concernProblemsOf(clientOf(settings.url)));
    this.client = clientOf(settings.url, ENFORCED_CLIENT_OPTIONS);
    requireConcerns(enforcementProblemsOf(this.client));
    this.db = this.client.db(settings.database ?? DEFAULT_DATABASE);
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
   * commit), retried by the driver on a transient error — `work` must be safe to run again. Each
   * operation of `work` passes `{ session }`.
   */
  async inTransaction<TResult>(
    work: (session: ClientSession) => Promise<TResult>,
  ): Promise<TResult> {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(work, this.#transactionOptions);
    } finally {
      await session.endSession();
    }
  }

  /** The start check: the deployment is a replica set or a sharded cluster. */
  async onInit(): Promise<void> {
    await this.deployment();
  }

  /** Closes the client when the instance stops (its stores are destroyed first: they depend on it). */
  async onDestroy(): Promise<void> {
    await this.client.close();
  }
}
