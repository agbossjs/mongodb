import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { endAbandonedTransactions, podAppName } from "./abandoned-sessions.js";
import { dropDatabases, dropOnServer } from "./drop-databases.js";
import { freshDatabaseName, REPLICA_SET_URL } from "./server.js";

/**
 * agbossjs/agboss#985 — the cause on a real replica set: a pod that dies inside a transaction
 * leaves it open, and the drop of its database waits for it (up to the server's 60 s limit); the
 * teardown ends those transactions of its own databases first.
 */
describe("agbossjs/agboss#985: a transaction left open by a pod", () => {
  const clients: MongoClient[] = [];
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
  });

  const client = (appName?: string): MongoClient => {
    const made = new MongoClient(REPLICA_SET_URL, appName === undefined ? {} : { appName });
    clients.push(made);
    return made;
  };

  /** A pod of `database` inside a transaction, as one killed there leaves it. */
  async function podInTransaction(database: string): Promise<void> {
    const pod = client(podAppName(database));
    const session = pod.startSession();
    session.startTransaction();
    await pod.db(database).collection("held").insertOne({ held: true }, { session });
  }

  it("blocks the drop within its bound, until the transaction is ended", async () => {
    const database = freshDatabaseName();
    const bystander = freshDatabaseName();
    const admin = client();
    await podInTransaction(database);
    await podInTransaction(bystander);

    const blocked = await dropDatabases([database], dropOnServer(admin), { boundMs: 1_000 });
    expect(blocked.dropped).toBe(0);
    expect(blocked.leaked.map((leak) => leak.database)).toEqual([database]);

    expect(await endAbandonedTransactions(admin, [database])).toBe(1);
    expect(await dropDatabases([database], dropOnServer(admin))).toEqual({
      dropped: 1,
      leaked: [],
    });

    // a transaction of a pod of another database is not this teardown's to end
    expect(await endAbandonedTransactions(admin, [database])).toBe(0);
    expect(await endAbandonedTransactions(admin, [bystander])).toBe(1);
    await dropDatabases([bystander], dropOnServer(admin));
  });

  it("nothing open: nothing ended, the drop is quick", async () => {
    const database = freshDatabaseName();
    const admin = client();
    await admin.db(database).collection("c").insertOne({ x: 1 });
    expect(await endAbandonedTransactions(admin, [database])).toBe(0);
    expect(await dropDatabases([database], dropOnServer(admin))).toEqual({
      dropped: 1,
      leaked: [],
    });
  });
});
