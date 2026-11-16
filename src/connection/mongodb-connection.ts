import {
  ApplicationContext,
  Clock,
  EnvironmentField,
  Injectable,
  type OnDestroy,
  type OnInit,
} from "@agboss/core";
import { SchemaSetup } from "@agboss/core/stores";
import { closeClientBounded } from "./close-bounded.js";
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
  MongoTransactionReadConcern,
} from "./concerns.js";
import { supportedTopologyOf, topologyOf, type MongoTopology } from "./deployment.js";
import { StoreOutcomeUnknownError } from "@agboss/core/stores";
import { commitErrorOf } from "./outcome.js";
import { checkSchema, migrateSchema } from "./schema-version.js";
import {
  checkedWatchLivenessOf,
  databaseOfUrl,
  DEFAULT_DATABASE,
  settingsOfEnvironment,
  type MongoConnectionSettings,
} from "./settings.js";
import type { MongoTransaction } from "./transaction.js";
import { rememberSettings } from "./watch-client.js";

/**
 * Each connection's start (`onInit`) while it runs or once it succeeded: a component keeps no state
 * of its own. A failed start is forgotten (agbossjs/agboss#891), so the next `onInit` tries again.
 */
const started = new WeakMap<MongoConnection, Promise<void>>();

/** A client of `url`: the driver parses it here and connects on the first operation only. */
function clientOf(url: string, options?: MongoClientOptions): MongoClient {
  try {
    return new MongoClient(url, options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MongoSettingsError({
      message: `mongodbUrl is not a usable MongoDB connection string: ${reason}`,
      cause: error,
    });
  }
}

/**
 * The MongoDB deployment of one application instance: one `MongoClient` on the environment's
 * `mongodbUrl`, shared by every MongoDB store the application lists. Its client always writes with
 * `w=majority` on the journal and reads at `majority` from the primary; a URL that asks for less
 * fails with `MongoDurabilityError` when the connection is built. At `onInit` it requires a
 * replica set (or a sharded cluster): a standalone `mongod` fails with `MongoDeploymentError`;
 * then it checks the schema (`SchemaSetup.Check`, the default: `MongoSchemaMissingError`,
 * `MongoSchemaTooNewError`), or migrates it first (`SchemaSetup.MigrateOnStart`). A failed start
 * closes the client. At `onDestroy`, after its stores, it closes the client. Created
 * by the container (`deps: [ApplicationContext]`) or by a script or a test from its settings
 * (`new MongoConnection({ url })`). The DI token the MongoDB stores will name in their `deps`.
 */
@Injectable({
  deps: [ApplicationContext, Clock],
  // checked at the application's assembly (agbossjs/agboss#511): a contract without mongodbUrl
  // fails with [environment.missing-field] before anything starts
  environmentFields: {
    mongodbUrl: EnvironmentField.secret(),
    mongodbDatabase: EnvironmentField.text({ optional: true }),
    mongodbTransactionReadConcern: EnvironmentField.text({ optional: true }),
    mongodbWatchLivenessSeconds: EnvironmentField.integer({ optional: true }),
    mongodbSchemaSetup: EnvironmentField.text({ optional: true }),
  },
})
export class MongoConnection implements OnInit, OnDestroy {
  /** The instance's client: every store's operations, every transaction's session. */
  readonly client: MongoClient;
  /** The database the stores' collections are in (`mongodbDatabase`, else the URL's, else `agboss`). */
  readonly db: Db;
  readonly #transactionOptions: TransactionOptions;
  readonly #schemaSetup: SchemaSetup;

  /**
   * @param clock bounds the close at the stop (agbossjs/agboss#923); a connection built without
   *   one closes in order only.
   */
  constructor(
    source: ApplicationContext | MongoConnectionSettings,
    private readonly clock?: Clock,
  ) {
    // a copy: the caller changing its object after this line must not bypass the checks below, nor
    // change what the watch reads later (agbossjs/agboss#1129)
    const settings: MongoConnectionSettings = Object.freeze({
      ...(source instanceof ApplicationContext
        ? settingsOfEnvironment(source.environment)
        : source),
    });
    checkedWatchLivenessOf(settings.watchLivenessSeconds);
    rememberSettings(this, settings);
    // what the URL alone asks for: a weaker concern there is refused, never silently overridden
    requireConcerns(concernProblemsOf(clientOf(settings.url)));
    // a field left `undefined` is left out, never written as `null`: a document reads back as given
    this.client = clientOf(settings.url, { ...ENFORCED_CLIENT_OPTIONS, ignoreUndefined: true });
    requireConcerns(enforcementProblemsOf(this.client));
    this.db = this.client.db(settings.database ?? databaseOfUrl(settings.url) ?? DEFAULT_DATABASE);
    this.#transactionOptions = transactionOptionsOf(
      settings.transactionReadConcern ?? MongoTransactionReadConcern.Snapshot,
    );
    this.#schemaSetup = settings.schemaSetup ?? SchemaSetup.Check;
  }

  /** The options every store transaction runs with (`inTransaction`). */
  get transactionOptions(): TransactionOptions {
    return this.#transactionOptions;
  }

  /** The deployment the client reaches (`hello`): a replica set, a sharded cluster or a standalone. */
  async topology(): Promise<MongoTopology> {
    return topologyOf(await this.#hello());
  }

  /**
   * The deployment the client reaches when the stores can run on it — a replica set or a sharded
   * cluster; a standalone `mongod` rejects with `MongoDeploymentError`.
   */
  async requireSupportedTopology(): Promise<MongoTopology> {
    return supportedTopologyOf(await this.#hello());
  }

  #hello(): Promise<unknown> {
    return this.db.admin().command({ hello: 1 });
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
   * - a commit whose reply was lost is sent once more by the driver — the same transaction, which
   *   the server commits once —: after one reset the retry learns the real outcome (agbossjs/agboss#1017);
   *   a commit that is still unknown after it (`UnknownTransactionCommitResult`, or a transport
   *   error: the retry's reply lost too) rejects at once with `StoreOutcomeUnknownError` (source
   *   `Transport`, `outcome.ts`): the transaction may have committed, the holder hands the tree
   *   over and the next one reads what was left; the work is never run again for it;
   * - any other error (the work's own, a fence's refusal) aborts and is rethrown as it is.
   *
   * Each operation of `work` passes `{ session: transaction.session }`.
   */
  async inTransaction<TResult>(
    work: (transaction: MongoTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    const session: ClientSession = this.client.startSession();
    const transaction: MongoTransaction = { session, db: this.db };
    // what a commit the driver could not resolve is read as: the driver, told to abort a transaction
    // it just failed to commit, throws its own error over ours — which this call then restores
    let lostCommit: unknown;
    try {
      // the commit is made here, so that what the driver could not resolve is read as unknown at
      // once, not committed again until the 120 s are over; `withTransaction` returns when the
      // callback has committed, and still runs the work again on a `TransientTransactionError`
      return await session.withTransaction(async () => {
        const result = await work(transaction);
        await session.commitTransaction().catch((error: unknown) => {
          const read = commitErrorOf(error);
          if (read instanceof StoreOutcomeUnknownError) lostCommit = read;
          throw read;
        });
        return result;
      }, this.#transactionOptions);
    } catch (error) {
      throw lostCommit ?? error;
    } finally {
      await session.endSession();
    }
  }

  /**
   * The start checks: the deployment is a replica set or a sharded cluster; then the schema —
   * checked (`SchemaSetup.Check`), or migrated first (`SchemaSetup.MigrateOnStart`); a collection
   * with another collation than the simple one is `MongoCollationNotSimpleError`. A second call
   * waits for the first; a failed start closes the client and is not kept, so a retry starts again.
   */
  onInit(): Promise<void> {
    const running = started.get(this);
    if (running !== undefined) return running;
    const ready = this.#start().catch(async (error: unknown) => {
      started.delete(this);
      // the start's error is the one to report: a close that fails too changes nothing
      await this.client.close().catch(() => undefined);
      throw error;
    });
    started.set(this, ready);
    return ready;
  }

  async #start(): Promise<void> {
    // a client a failed start closed connects again (a connected one: nothing to do)
    await this.client.connect();
    await this.requireSupportedTopology();
    // a start that migrates never waits for the other instances' leases: a rolling restart would
    // deadlock on its own (agbossjs/agboss#1104; the explicit `migrate` is the guarded one)
    if (this.#schemaSetup === SchemaSetup.MigrateOnStart)
      await migrateSchema(this.db, { allowLiveLeases: true });
    else await checkSchema(this.db);
  }

  /** Closes the client when the instance stops (its stores are destroyed first: they depend on it). */
  async onDestroy(): Promise<void> {
    await closeClientBounded(this.client, this.clock);
  }
}
