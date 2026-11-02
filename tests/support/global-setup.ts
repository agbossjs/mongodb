import { MongoClient } from "mongodb";
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

export default async function requireMongo(): Promise<void> {
  const servers = [
    ["AGBOSS_MONGODB_TEST_URL", REPLICA_SET_URL],
    ["AGBOSS_MONGODB_STANDALONE_TEST_URL", STANDALONE_URL],
  ] as const;
  const missing = servers.filter(([, url]) => url === "").map(([name]) => name);
  if (missing.length > 0)
    throw new Error(`${missing.join(" and ")} not set: the tests need a real MongoDB — ${HOW_TO}`);
  for (const [name, url] of servers) await requireAnswer(name, url);
}
