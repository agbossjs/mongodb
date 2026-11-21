import { MongoClient } from "mongodb";
import { z } from "zod";
import { HOW_TO, REPLICA_SET_URL, STANDALONE_URL } from "./server.js";

/**
 * Every store test of this repository runs against a real MongoDB: `AGBOSS_MONGODB_TEST_URL` names
 * a replica set (three members with `enableTestCommands=1`: the failover and retry tests need
 * them), `AGBOSS_MONGODB_STANDALONE_TEST_URL` a standalone `mongod` (the start check must refuse
 * it). Without them — or when one does not answer — the run fails here, before any test, saying
 * how to start them; a test is never skipped.
 */
async function requireAnswer(name: string, url: string): Promise<void> {
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 10_000 });
  try {
    await client.db("admin").command({ ping: 1 });
  } catch (error) {
    throw new Error(`${name} does not answer (${String(error)}) — ${HOW_TO}`);
  } finally {
    await client.close();
  }
}

/**
 * A mutation run kills the mutant that hangs inside a transaction (Stryker's hit limit, its time
 * limit) and leaves that transaction open on the server for its lifetime — 60 s by default — and
 * the next mutant's reset of the same database waits for it: a hook that times out, a RuntimeError
 * Stryker leaves out of the score (agbossjs/mongodb#103). Each member's lifetime is 10 s for the run.
 */
async function shortenTransactions(url: string): Promise<void> {
  const seeds = new MongoClient(url, { serverSelectionTimeoutMS: 10_000 });
  try {
    const { hosts } = z
      .object({ hosts: z.array(z.string()) })
      .parse(await seeds.db("admin").command({ hello: 1 }));
    for (const host of hosts) {
      const member = new MongoClient(`mongodb://${host}/?directConnection=true`);
      try {
        await member.db("admin").command({ setParameter: 1, transactionLifetimeLimitSeconds: 10 });
      } finally {
        await member.close();
      }
    }
  } finally {
    await seeds.close();
  }
}

export default async function requireMongo(): Promise<void> {
  const servers = [
    ["AGBOSS_MONGODB_TEST_URL", REPLICA_SET_URL],
    ["AGBOSS_MONGODB_STANDALONE_TEST_URL", STANDALONE_URL],
  ] as const;
  const missing = servers.filter(([, url]) => url === "").map(([name]) => name);
  if (missing.length > 0)
    throw new Error(`${missing.join(" and ")} not set: the tests need a real MongoDB — ${HOW_TO}`);
  for (const [name, url] of servers) await requireAnswer(name, url);
  if (process.env.MUTATION_SHARD !== undefined) await shortenTransactions(REPLICA_SET_URL);
}
