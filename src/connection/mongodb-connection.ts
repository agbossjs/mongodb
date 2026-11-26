import { Clock, Injectable, type OnDestroy, type OnInit } from "@agboss/core";
import { DATABASE_SETTINGS, SchemaSetup, type ResolvedSettings } from "@agboss/core/stores";
import { assertDriverInternals, closeClientBounded } from "./close-bounded.js";
import {
  MongoClient,
  type ClientSession,
  type Db,
  type MongoClientOptions,
  type TransactionOptions,
} from "mongodb";
import { MongoSettingsError } from "../errors.js";
import { settingsOfResolved } from "./driver-settings.js";
import {
  concernProblemsOf,
  enforcementProblemsOf,
  ENFORCED_CLIENT_OPTIONS,
  requireConcerns,
  transactionOptionsOf,
  MongoTransactionReadConcern,
} from "./concerns.js";
import { supportedTopologyOf, topologyOf, type MongoTopology } from "./deployment.js";
import { classifiedDb } from "./classified-db.js";
import { requiredTransaction } from "./ambient.js";
import { commitErrorOf } from "./outcome.js";
import { sleepOn } from "./live-leases.js";
import { checkSchema, migrateAtStart } from "./schema-version.js";
import {
  checkedWatchLivenessOf,
  databaseOfUrl,
  DEFAULT_DATABASE,
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
 * The settings of a connection: the resolved settings of the application's `@DatabaseStorage` of
 * `MongoDriver` (agbossjs/agboss#1321), else the settings object a script or a test gave. An
 * application with no MongoDB storage and no object is `MongoSettingsError`: the environment is no
 * source of the connection any more (agbossjs/agboss#1324).
 */
function settingsOf(
  source: MongoConnectionSettings | ResolvedSettings | undefined,
): MongoConnectionSettings {
  if (source === undefined)
    throw new MongoSettingsError({
      message:
        "the MongoDB stores need the application's @DatabaseStorage({ driver: MongoDriver({ url: secret(…) }) }) — the database they open",
    });
  if ("kind" in source) return settingsOfResolved(source);
  return source;
}

/**
 * The MongoDB deployment of one application instance: one `MongoClient` on the `url` of the
 * application's `@DatabaseStorage({ driver: MongoDriver({ url }) })`, shared by every MongoDB store
 * the application lists. Its client always writes with
 * `w=majority` on the journal and reads at `majority` from the primary; a URL that asks for less
 * fails with `MongoDurabilityError` when the connection is built. At `onInit` it requires a
 * replica set (or a sharded cluster): a standalone `mongod` fails with `MongoDeploymentError`;
 * then it checks the schema (`SchemaSetup.Check`, the default: `MongoSchemaMissingError`,
 * `MongoSchemaTooNewError`), or migrates it first (`SchemaSetup.MigrateOnStart`). A failed start
 * closes the client. At `onDestroy`, after its stores, it closes the client. Created
 * by the container (`deps: [DATABASE_SETTINGS, Clock]`) or by a script or a test from its settings
 * (`new MongoConnection({ url })`). The DI token the MongoDB stores will name in their `deps`.
 */
@Injectable({ deps: [DATABASE_SETTINGS, Clock] })
export class MongoConnection implements OnInit, OnDestroy {
  /** The instance's client: every store's operations, every transaction's session. */
  readonly client: MongoClient;
  /**
   * The database the stores' collections are in (`mongodbDatabase`, else the URL's, else `agboss`):
   * a write of its collections outside a transaction reads an error of unknown outcome as
   * `StoreError.OutcomeUnknown` (agbossjs/mongodb#76).
   */
  readonly db: Db;
  readonly #rawDb: Db;
  readonly #transactionOptions: TransactionOptions;
  readonly #schemaSetup: SchemaSetup;
  readonly #allowLiveLeases: boolean;

  /**
   * @param clock bounds the close at the stop (agbossjs/agboss#923); a connection built without
   *   one closes in order only.
   */
  constructor(
    source?: MongoConnectionSettings | ResolvedSettings,
    private readonly clock?: Clock,
  ) {
    // a copy: the caller changing its object after this line must not bypass the checks below, nor
    // change what the watch reads later (agbossjs/agboss#1129)
    const settings: MongoConnectionSettings = Object.freeze({
      ...settingsOf(source),
    });
    checkedWatchLivenessOf(settings.watchLivenessSeconds);
    rememberSettings(this, settings);
    // what the URL alone asks for: a weaker concern there is refused, never silently overridden
    requireConcerns(concernProblemsOf(clientOf(settings.url)));
    // a field left `undefined` is left out, never written as `null`: a document reads back as given
    this.client = clientOf(settings.url, { ...ENFORCED_CLIENT_OPTIONS, ignoreUndefined: true });
    requireConcerns(enforcementProblemsOf(this.client));
    this.#rawDb = this.client.db(
      settings.database ?? databaseOfUrl(settings.url) ?? DEFAULT_DATABASE,
    );
    this.db = classifiedDb(this.#rawDb);
    this.#transactionOptions = transactionOptionsOf(
      settings.transactionReadConcern ?? MongoTransactionReadConcern.Snapshot,
    );
    this.#schemaSetup = settings.schemaSetup ?? SchemaSetup.Check;
    this.#allowLiveLeases = settings.allowLiveLeases === true;
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

  /**
   * The transaction of the `runOnce` the caller is inside of (agbossjs/agboss#1317c): the effect's
   * business documents are written through it (`{ session }`) and roll back with it on any uncaught
   * error. `IdempotencyError.OutsideTransaction` outside one.
   */
  requireTransaction(): MongoTransaction {
    return requiredTransaction(this);
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
   *   a commit that fails after it — whatever the error: the driver retries by itself, so the one
   *   seen may be the retry's after a first attempt that committed — rejects at once with `StoreError.OutcomeUnknown` (source
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
          lostCommit = commitErrorOf(error);
          throw lostCommit;
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
    // the bounded stop (#954) reaches the driver's internals: a driver without them fails here (#1236)
    assertDriverInternals(this.client);
    await this.requireSupportedTopology();
    // no rolling upgrade across a schema change (agbossjs/agboss#1104, ADR-0034): a start that
    // migrates a migrated database waits for live leases to lapse and refuses while one is live
    if (this.#schemaSetup === SchemaSetup.MigrateOnStart)
      await migrateAtStart(this.#rawDb, {
        allowLiveLeases: this.#allowLiveLeases,
        sleep: sleepOn(this.clock),
      });
    else await checkSchema(this.db);
  }

  /** Closes the client when the instance stops (its stores are destroyed first: they depend on it). */
  async onDestroy(): Promise<void> {
    await closeClientBounded(this.client, this.clock);
  }
}
