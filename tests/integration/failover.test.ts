/**
 * agbossjs/agboss#527 AC3 — why the stores need `w=majority`, shown on a real failover of the test
 * replica set (three members, `enableTestCommands=1`). Replication to both secondaries is stopped
 * (their `stopReplProducer` fail point), a lease is taken, and the primary is forced to step down:
 * a secondary without the lease becomes the primary.
 *
 * - A lease store writing at `w=1` (a sabotage: the connection refuses such a URL) is told "taken"
 *   by the old primary alone; after the failover the lease is gone and another instance takes the
 *   same epoch — **two owners**. The proof fails as it should.
 * - The package's store (`w=majority`) is not told "taken" until a majority has it: its write waits,
 *   the step-down interrupts it, the driver retries it once on the new primary, and there is one
 *   owner — the other instance is refused.
 */
import { StoreClock } from "@agboss/core";
import { minutes } from "@agboss/core/units";
import { MongoClient, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MongoConcernTooWeakError,
  MongoConnection,
  MongoExecutionLeaseRepository,
} from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { openConnection, testDatabase } from "../support/database.js";
import { REPLICA_SET_URL } from "../support/server.js";

const database = testDatabase();

class ServerClock extends StoreClock {
  readonly isDatabaseTime = true;
  now(): Date {
    return new Date();
  }
}

/** A connection whose stores write at `w=1`: what the real connection refuses to build. */
class OneMemberConnection extends MongoConnection {
  override readonly db: Db = this.client.db(database.name(), { writeConcern: { w: 1 } });
}

const Status = z.object({
  members: z.array(z.object({ name: z.string(), stateStr: z.string() })),
});

/** The replica set's members by state. */
async function membersOf(client: MongoClient): Promise<{ name: string; stateStr: string }[]> {
  return Status.parse(await client.db("admin").command({ replSetGetStatus: 1 })).members;
}

/** A direct client of one member. */
const memberClient = (name: string): MongoClient =>
  new MongoClient(`mongodb://${name}/?directConnection=true`);

/** Stops replication on every secondary (`alwaysOn`), or lets it run again on every member (`off`). */
async function replicationOnSecondaries(
  client: MongoClient,
  mode: "alwaysOn" | "off",
): Promise<void> {
  for (const member of await membersOf(client)) {
    if (mode === "alwaysOn" && member.stateStr !== "SECONDARY") continue;
    const secondary = memberClient(member.name);
    try {
      await secondary.db("admin").command({ configureFailPoint: "stopReplProducer", mode });
    } finally {
      await secondary.close();
    }
  }
}

/** Forces the primary to step down (for 60 s it is not elected again). */
async function stepDownPrimary(client: MongoClient): Promise<string> {
  const primary = (await membersOf(client)).find((member) => member.stateStr === "PRIMARY");
  if (primary === undefined) throw new Error("the replica set has no primary");
  const direct = memberClient(primary.name);
  try {
    await direct.db("admin").command({ replSetStepDown: 60, force: true });
  } catch {
    // the step-down closes the connections it was asked on
  } finally {
    await direct.close();
  }
  return primary.name;
}

/** Resolves once a member other than `old` is the primary. */
async function newPrimaryOtherThan(client: MongoClient, old: string): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const primary = (await membersOf(client).catch(() => [])).find(
      (member) => member.stateStr === "PRIMARY",
    );
    if (primary !== undefined && primary.name !== old) return primary.name;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("no new primary was elected");
}

const Config = z.object({
  config: z.object({ members: z.array(z.object({ host: z.string(), priority: z.number() })) }),
});

/** Sends `command` to every member but the primary, ignoring a member that refuses it. */
async function toEveryMember(client: MongoClient, command: Record<string, unknown>): Promise<void> {
  for (const member of await membersOf(client).catch(() => [])) {
    const direct = memberClient(member.name);
    try {
      await direct.db("admin").command(command);
    } catch {
      // a primary refuses replSetFreeze; a member being elected may not answer yet
    } finally {
      await direct.close();
    }
  }
}

/**
 * Replication on again on every member, none frozen, and the set back as it was: every member a
 * healthy primary or secondary, the member of the highest priority the primary — so the files after
 * this one see no election of their own.
 */
async function healed(client: MongoClient): Promise<void> {
  await replicationOnSecondaries(client, "off").catch(() => undefined);
  await toEveryMember(client, { replSetFreeze: 0 });
  const { members: configured } = Config.parse(
    await client.db("admin").command({ replSetGetConfig: 1 }),
  ).config;
  const preferred = [...configured].sort((left, right) => right.priority - left.priority)[0]?.host;
  for (let attempt = 0; attempt < 360; attempt += 1) {
    const members = await membersOf(client).catch(() => []);
    const isHealthy =
      members.length >= 3 &&
      members.every((member) => ["PRIMARY", "SECONDARY"].includes(member.stateStr)) &&
      members.some((member) => member.stateStr === "PRIMARY" && member.name === preferred);
    if (isHealthy) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("the replica set did not heal");
}

const leasesOn = (connection: MongoConnection, instanceId: string): MongoExecutionLeaseRepository =>
  new MongoExecutionLeaseRepository(
    connection,
    new ServerClock(),
    new TestApplicationContext({}, instanceId),
  );

let admin: MongoClient;

const ReplicaSetConfig = z.object({
  config: z.looseObject({
    version: z.number(),
    settings: z.looseObject({ catchUpTimeoutMillis: z.number() }),
  }),
});

/**
 * Sets how long a newly elected primary catches up with a fresher member before it takes writes,
 * returning the value it had. The failovers here elect a member whose replication is stopped: with
 * the default (no limit) it would wait for the old primary's writes forever; at 0 it takes the
 * writes it has — the old primary's unreplicated writes are rolled back, as in a real partition.
 */
async function catchUpTimeout(client: MongoClient, millis: number): Promise<number> {
  const { config } = ReplicaSetConfig.parse(
    await client.db("admin").command({ replSetGetConfig: 1 }),
  );
  const before = config.settings.catchUpTimeoutMillis;
  const settings = { ...config.settings, catchUpTimeoutMillis: millis };
  await client.db("admin").command({
    replSetReconfig: { ...config, version: config.version + 1, settings },
  });
  return before;
}

let catchUpBefore = -1;

beforeAll(async () => {
  admin = new MongoClient(REPLICA_SET_URL);
  const members = await membersOf(admin);
  if (members.length < 3)
    throw new Error(
      `the failover tests need a replica set of three members, AGBOSS_MONGODB_TEST_URL has ${String(members.length)}`,
    );
  catchUpBefore = await catchUpTimeout(admin, 0);
});

afterAll(async () => {
  await healed(admin);
  await catchUpTimeout(admin, catchUpBefore);
  await admin.close();
});

describe("agbossjs/agboss#527 AC3: a lease across a failover", () => {
  it("the connection refuses a URL with w=1, which the sabotage below builds around", () => {
    expect(() => new MongoConnection({ url: `${database.url()}&w=1` })).toThrow(
      MongoConcernTooWeakError,
    );
  });

  it("at w=1 a lease the old primary acknowledged is lost by the failover: another instance takes the same epoch — two owners", async () => {
    const zombie = new OneMemberConnection({ url: database.url() });
    const other = await openConnection(database.url());
    try {
      await replicationOnSecondaries(admin, "alwaysOn");
      const first = await leasesOn(zombie, "instance-1").acquire("default", "w1-tree", minutes(5));
      const old = await stepDownPrimary(admin);
      await newPrimaryOtherThan(admin, old);
      const second = await leasesOn(other, "instance-2").acquire("default", "w1-tree", minutes(5));

      // the sabotage fails as it should: one epoch, two holders
      expect(first?.leaseEpoch).toBe(1);
      expect(second?.leaseEpoch).toBe(1);
      expect(second?.holderInstanceId).not.toBe(first?.holderInstanceId);
    } finally {
      await healed(admin);
      await zombie.onDestroy();
      await other.onDestroy();
    }
  }, 240_000);

  it("at w=majority the take is acknowledged only once a majority has it: after the failover one owner, the other refused", async () => {
    const holder = await openConnection(database.url());
    const other = await openConnection(database.url());
    try {
      await replicationOnSecondaries(admin, "alwaysOn");
      const taking = leasesOn(holder, "instance-1").acquire("default", "majority-tree", minutes(5));
      const old = await stepDownPrimary(admin);
      await newPrimaryOtherThan(admin, old);
      await replicationOnSecondaries(admin, "off");
      const first = await taking;
      const second = await leasesOn(other, "instance-2").acquire(
        "default",
        "majority-tree",
        minutes(5),
      );

      expect(first?.leaseEpoch).toBe(1);
      expect(first?.holderInstanceId).toBe("instance-1");
      expect(second).toBeUndefined();
    } finally {
      await healed(admin);
      await holder.onDestroy();
      await other.onDestroy();
    }
  }, 240_000);
});
