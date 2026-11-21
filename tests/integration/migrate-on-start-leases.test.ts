/**
 * agbossjs/agboss#1260 (#1104, ADR-0034): no rolling upgrade across a schema change, `MigrateOnStart`
 * included — as `@agboss/postgres` does it. A start that has migrations to apply waits for the live
 * execution leases to lapse (the old instance stopped: its leases do) and fails with
 * `MongoLiveLeasesError` while one is live (the old instance still renewing); `allowLiveLeases`, and
 * `mongodbAllowLiveLeases` in the environment, keep the override. Nothing to apply: no look.
 *
 * The waits are scaled (`leaseWait`) or counted (a `Clock` that sleeps at once): no test waits minutes.
 */
import { ExecutionLeaseRepository, StoreClock } from "@agboss/core";
import { SchemaSetup } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { setTimeout as delay } from "node:timers/promises";
import { MongoClient, type Db } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import {
  Collections,
  migrateMongodb,
  MongoConnection,
  MongoExecutionLeaseRepository,
  MongoLiveLeasesError,
} from "../../src/index.js";
import {
  leaseWaitFor,
  waitForLeasesToLapse,
  type LeaseWait,
} from "../../src/connection/live-leases.js";
import { migrateAtStart, SCHEMA_VERSION } from "../../src/connection/schema-version.js";
import { treeIdOf } from "../../src/stores/keys.js";
import { dropDatabase } from "../support/database.js";
import { freshDatabaseName, REPLICA_SET_URL } from "../support/server.js";
import { revealing, TestApplicationContext } from "../support/application-context.js";

const made: string[] = [];
afterAll(async () => {
  for (const database of made) await dropDatabase(database);
});

const HOUR = 3_600_000;
/** The process's timer: the polls of a wait that is really waited (scaled to a second or two). */
const REALLY = (ms: number): Promise<void> => delay(ms);
const SHORT: LeaseWait = { maxMs: 600, pollMs: 100, capMs: 600 };

const urlOn = (database: string): string =>
  REPLICA_SET_URL.replace(/^(mongodb(?:\+srv)?:\/\/[^/?]*)\/?[^?]*/u, `$1/${database}`);

/** `work` on a plain client of `database`. */
async function onDatabase<T>(database: string, work: (db: Db) => Promise<T>): Promise<T> {
  const client = new MongoClient(REPLICA_SET_URL);
  try {
    return await work(client.db(database));
  } finally {
    await client.close();
  }
}

const setVersion = (database: string, version: number): Promise<unknown> =>
  onDatabase(database, (db) =>
    db
      .collection<{ _id: string }>(Collections.SchemaVersion)
      .updateOne({ _id: "agboss" }, { $set: { version } }),
  );

const versionOf = (database: string): Promise<unknown> =>
  onDatabase(
    database,
    async (db) =>
      (
        await db
          .collection<{ _id: string; version: number }>(Collections.SchemaVersion)
          .findOne({ _id: "agboss" }, { projection: { _id: 0, version: 1 } })
      )?.version,
  );

/** A migrated database whose version is set back: the schema the build before this one left. */
async function databaseAt(version: number): Promise<string> {
  const database = freshDatabaseName();
  made.push(database);
  await migrateMongodb({ url: REPLICA_SET_URL, database });
  if (version !== SCHEMA_VERSION) await setVersion(database, version);
  return database;
}

/** A lease of `old-pod` on `run-1`, expiring in `ms` milliseconds (on the same machine's clock as the server). */
const leasedFor = (database: string, ms: number): Promise<unknown> =>
  onDatabase(database, (db) =>
    db.collection<{ _id: string }>(Collections.ExecutionLeases).insertOne({
      _id: treeIdOf("default", "run-1"),
      ...{ tenantId: "default", rootExecutionId: "run-1", holderInstanceId: "old-pod" },
      ...{ token: 1, expiresAt: new Date(Date.now() + ms) },
      ...{ released: false, yielded: false, superseded: false, finished: false },
    }),
  );

/** A database one migration behind, with a live lease of `ms`. */
async function behindWithLease(ms: number): Promise<string> {
  const database = await databaseAt(SCHEMA_VERSION - 1);
  await leasedFor(database, ms);
  return database;
}

/**
 * A clock whose sleeps end at once, counted: the start's polls without the waiting. `polls` is what
 * the start itself slept (the close at the stop sleeps on the clock too, and is not counted).
 */
class QuickClock extends VirtualClock {
  sleeps = 0;
  polls = 0;

  override sleep(): Promise<void> {
    this.sleeps += 1;
    return Promise.resolve();
  }
}

/** The start of `connection` on `clock`: what it rejected with (if it did), then it is stopped. */
async function startedWith(connection: MongoConnection, clock: QuickClock): Promise<unknown> {
  const outcome = await connection.onInit().then(
    () => undefined,
    (reason: unknown) => reason,
  );
  clock.polls = clock.sleeps;
  await connection.onDestroy();
  return outcome;
}

/** A start of `database` as the application's pod makes it, on `clock`; rejects with the start's error. */
async function startOn(
  database: string,
  clock: QuickClock,
  extra: { allowLiveLeases?: boolean } = {},
): Promise<void> {
  const connection = new MongoConnection(
    { url: urlOn(database), schemaSetup: SchemaSetup.MigrateOnStart, ...extra },
    clock,
  );
  const failure = await startedWith(connection, clock);
  if (failure instanceof Error) throw failure;
}

/** `migrateAtStart` with sleeps counted and returning at once. */
function atStart(database: string, extra: Parameters<typeof migrateAtStart>[1] = {}) {
  let sleeps = 0;
  const run = () =>
    onDatabase(database, (db) =>
      migrateAtStart(db, {
        sleep: () => {
          sleeps += 1;
          return Promise.resolve();
        },
        ...extra,
      }),
    );
  return { run, sleeps: () => sleeps };
}

describe("#1260: a start that migrates and the live leases", () => {
  it("a single instance upgraded: its stopped pod's lease lapses, the start waits, then migrates", async () => {
    const database = await behindWithLease(1_500);

    await onDatabase(database, (db) =>
      migrateAtStart(db, { leaseWait: { maxMs: 20_000, pollMs: 200 }, sleep: REALLY }),
    );

    expect(await versionOf(database)).toBe(SCHEMA_VERSION);
  });

  it("a rolling restart, the old pod alive: refused with MongoLiveLeasesError, nothing applied", async () => {
    const database = await behindWithLease(HOUR);

    const error = await onDatabase(database, (db) =>
      migrateAtStart(db, { leaseWait: SHORT, sleep: REALLY }),
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MongoLiveLeasesError);
    expect(error).toMatchObject({ code: "mongodb.live-leases", count: 1, holders: ["old-pod"] });
    expect(await versionOf(database)).toBe(SCHEMA_VERSION - 1);
  });

  it("the MongoConnection start is the same: refused after the cap's 600 polls (none really slept), the version left", async () => {
    const database = await behindWithLease(HOUR);
    const clock = new QuickClock();

    const error = await startOn(database, clock).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MongoLiveLeasesError);
    expect(error).toMatchObject({ message: expect.stringContaining("mongodbAllowLiveLeases") });
    expect(clock.polls).toBe(600);
    expect(await versionOf(database)).toBe(SCHEMA_VERSION - 1);
  });

  it("the start's refusal names the environment switch next to the setting", async () => {
    const database = await behindWithLease(HOUR);

    const error = await startOn(database, new QuickClock()).catch((reason: unknown) => reason);

    expect(String(error)).toMatch(/allowLiveLeases.*mongodbAllowLiveLeases/u);
  });

  it("a connection built without a Clock (a script) cannot wait: refused at once, as migrate is", async () => {
    // a lease that would lapse within the wait, and 30 s: a loaded machine takes seconds to reach the start
    const database = await behindWithLease(30_000);
    const connection = new MongoConnection({
      url: urlOn(database),
      schemaSetup: SchemaSetup.MigrateOnStart,
    });

    try {
      await expect(connection.onInit()).rejects.toBeInstanceOf(MongoLiveLeasesError);
    } finally {
      await connection.onDestroy();
    }

    expect(await versionOf(database)).toBe(SCHEMA_VERSION - 1);
  });

  it("allowLiveLeases: the override migrates over the live lease at once, with no wait", async () => {
    const database = await behindWithLease(HOUR);
    const clock = new QuickClock();

    await startOn(database, clock, { allowLiveLeases: true });

    expect(await versionOf(database)).toBe(SCHEMA_VERSION);
    expect(clock.polls).toBe(0);
  });

  it("mongodbAllowLiveLeases in the application's environment is the same override", async () => {
    const database = await behindWithLease(HOUR);
    const clock = new QuickClock();
    const connection = new MongoConnection(
      new TestApplicationContext({
        mongodbUrl: revealing(urlOn(database)),
        mongodbSchemaSetup: SchemaSetup.MigrateOnStart,
        mongodbAllowLiveLeases: true,
      }),
      clock,
    );

    expect(await startedWith(connection, clock)).toBeUndefined();

    expect(await versionOf(database)).toBe(SCHEMA_VERSION);
    expect(clock.polls).toBe(0);
  });

  it("no migration pending: a restart with a live lease starts at once", async () => {
    const database = await databaseAt(SCHEMA_VERSION);
    await leasedFor(database, HOUR);
    const clock = new QuickClock();

    await startOn(database, clock);

    expect(await versionOf(database)).toBe(SCHEMA_VERSION);
    expect(clock.polls).toBe(0);
  });

  it("a database never migrated (the first start) has no instance to stop: the live leases are not looked at", async () => {
    const database = freshDatabaseName();
    made.push(database);
    await leasedFor(database, HOUR);
    const clock = new QuickClock();

    await startOn(database, clock);

    expect(await versionOf(database)).toBe(SCHEMA_VERSION);
    expect(clock.polls).toBe(0);
  });

  it("a newer schema is refused before any wait", async () => {
    const database = await databaseAt(SCHEMA_VERSION);
    await setVersion(database, SCHEMA_VERSION + 1);
    await leasedFor(database, HOUR);
    const clock = new QuickClock();

    await expect(startOn(database, clock)).rejects.toMatchObject({
      code: "mongodb.schema-too-new",
    });

    expect(clock.polls).toBe(0);
  });

  it("the explicit migrate is still refused at once, with no wait", async () => {
    const database = await behindWithLease(HOUR);

    await expect(migrateMongodb({ url: REPLICA_SET_URL, database })).rejects.toBeInstanceOf(
      MongoLiveLeasesError,
    );
  });
});

describe("#1260: how long the start waits", () => {
  it("twice the lease left: a 45 s lease waits 90 s; the default is the floor; ten minutes the cap", () => {
    const defaults = { maxMs: 60_000, pollMs: 1_000 };

    expect(leaseWaitFor(45_000, defaults)).toBe(90_000);
    expect(leaseWaitFor(20_000, defaults)).toBe(60_000);
    expect(leaseWaitFor(0, defaults)).toBe(60_000);
    expect(leaseWaitFor(HOUR, defaults)).toBe(600_000);
    expect(leaseWaitFor(HOUR, { ...defaults, capMs: 120_000 })).toBe(120_000);
  });

  it("the polls are counted from the lease the server shows: 45 s left, 90 polls; 20 s, the floor's 60; an hour, the cap's 600", async () => {
    const counts: number[] = [];
    for (const ms of [45_000, 20_000, HOUR]) {
      const database = await behindWithLease(ms);
      const start = atStart(database);
      await start.run().catch(() => undefined);
      counts.push(start.sleeps());
    }

    expect(counts).toEqual([90, 60, 600]);
  });

  it("a lease longer than the floor is waited for: 3 s left, a 600 ms floor, the start still migrates", async () => {
    const database = await behindWithLease(3_000);

    await onDatabase(database, (db) =>
      migrateAtStart(db, { leaseWait: { maxMs: 600, pollMs: 100 }, sleep: REALLY }),
    );

    expect(await versionOf(database)).toBe(SCHEMA_VERSION);
  });

  it("a lease past the cap is refused, not waited for", async () => {
    const database = await behindWithLease(3_000);

    const error = await onDatabase(database, (db) =>
      migrateAtStart(db, { leaseWait: { maxMs: 600, pollMs: 100, capMs: 800 }, sleep: REALLY }),
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MongoLiveLeasesError);
  });
});

describe("#1260: the wait polls only while a lease is live", () => {
  it("no live lease: no sleep at all, the start goes on at once", async () => {
    const database = await databaseAt(SCHEMA_VERSION);
    let sleeps = 0;

    await onDatabase(database, (db) =>
      waitForLeasesToLapse(db, { maxMs: 60_000, pollMs: 1_000 }, () => {
        sleeps += 1;
        return Promise.resolve();
      }),
    );

    expect(sleeps).toBe(0);
  });

  it("a live lease that lapses: the wait sleeps, and only until it has lapsed", async () => {
    const database = await behindWithLease(1_000);
    let sleeps = 0;

    await onDatabase(database, (db) =>
      waitForLeasesToLapse(db, { maxMs: 5_000, pollMs: 200 }, () => {
        sleeps += 1;
        return delay(200);
      }),
    );

    expect(sleeps).toBeGreaterThan(0);
    expect(sleeps).toBeLessThan(25);
  });
});

/**
 * The old instance, for real: a running `MongoConnection` and the lease store the core's holder
 * uses, taking a lease and renewing it as a holder does until it stops.
 */
class OldInstance {
  readonly connection: MongoConnection;
  #renewal: NodeJS.Timeout | undefined;
  /** The renewals sent and not yet answered: the stop waits for them, so none meets a closed client. */
  readonly #renewing = new Set<Promise<unknown>>();

  constructor(database: string) {
    this.connection = new MongoConnection({ url: urlOn(database) });
  }

  /** Starts, takes the lease of a run for 2 s and renews it every 200 ms. */
  async hold(): Promise<void> {
    await this.connection.onInit();
    const leases: ExecutionLeaseRepository = new MongoExecutionLeaseRepository(
      this.connection,
      new StoreClock(),
      new TestApplicationContext({}, "old-pod"),
    );
    const held = await leases.acquire("default", "run-1", seconds(2));
    if (held === undefined) throw new Error("the old instance must take the lease");
    this.#renewal = setInterval(() => {
      const renewing = leases.renew(held, seconds(2)).catch(() => undefined);
      this.#renewing.add(renewing);
      void renewing.finally(() => this.#renewing.delete(renewing));
    }, 200);
  }

  /** The instance stops: it renews no more (its last lease lapses on the server's clock). */
  async stop(): Promise<void> {
    clearInterval(this.#renewal);
    await Promise.all([...this.#renewing]);
    await this.connection.onDestroy();
  }
}

describe("#1260: a second instance holding a lease, the new build starting with MigrateOnStart", () => {
  it("refuses while the old instance renews, and migrates once it has stopped and its lease lapsed", async () => {
    const database = await databaseAt(SCHEMA_VERSION);
    const old = new OldInstance(database);
    await old.hold();
    // the new build brings one migration more than the schema the old one runs on
    await setVersion(database, SCHEMA_VERSION - 1);

    const refused = await onDatabase(database, (db) =>
      migrateAtStart(db, { leaseWait: SHORT, sleep: REALLY }),
    ).catch((reason: unknown) => reason);

    expect(refused).toBeInstanceOf(MongoLiveLeasesError);
    expect(refused).toMatchObject({ count: 1, holders: ["old-pod"] });
    expect(await versionOf(database)).toBe(SCHEMA_VERSION - 1);

    await old.stop();
    await onDatabase(database, (db) =>
      migrateAtStart(db, { leaseWait: { maxMs: 30_000, pollMs: 200 }, sleep: REALLY }),
    );

    expect(await versionOf(database)).toBe(SCHEMA_VERSION);
  });
});
