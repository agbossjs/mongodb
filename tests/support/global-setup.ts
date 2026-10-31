import { MongoClient } from "mongodb";
import { HOW_TO, REPLICA_SET_URL, STANDALONE_URL } from "./server.js";

/**
 * The integration tests run against a real MongoDB. In CI (`CI` set) both URLs are required: a
 * missing one fails the run here, before any test — CI never skips them. Locally, without the
 * URLs, they are skipped and this says so; a URL that is set but does not answer fails the run.
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
  if (missing.length > 0 && process.env.CI !== undefined && process.env.CI !== "")
    throw new Error(
      `${missing.join(" and ")} not set in CI: the integration tests never skip there — ${HOW_TO}`,
    );
  if (missing.length > 0)
    process.stderr.write(
      `\n[agboss-mongodb] ${missing.join(" and ")} not set: the integration tests against a real MongoDB are SKIPPED (they run in CI). To run them, ${HOW_TO}\n\n`,
    );
  for (const [name, url] of servers) if (url !== "") await requireAnswer(name, url);
}
