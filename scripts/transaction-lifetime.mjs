// The servers' transaction lifetime for the length of a mutation run (agbossjs/mongodb#103).
// A mutation run kills the mutant that hangs inside a transaction (Stryker's hit limit, its time limit) and leaves that
// transaction open on the server for its lifetime (`transactionLifetimeLimitSeconds`, 60 s by default), and the next
// mutant's reset of the same database waits for it: a hook that times out, a RuntimeError Stryker leaves out of the score.
// The limit is a server-wide parameter of every member, so it is put back when the run ends, whatever its outcome: a
// run that left 10 s behind changed every later `npm run check` of the same servers.
import { MongoClient } from "mongodb";

const PARAMETER = "transactionLifetimeLimitSeconds";

/** The members of the replica set `url` names, each as a direct connection string. */
async function membersOf(url) {
  const seeds = new MongoClient(url, { serverSelectionTimeoutMS: 10_000 });
  try {
    const { hosts } = await seeds.db("admin").command({ hello: 1 });
    if (!Array.isArray(hosts) || hosts.length === 0)
      throw new Error(`${url} is no replica set: hello lists no hosts`);
    return hosts.map((host) => `mongodb://${host}/?directConnection=true`);
  } finally {
    await seeds.close();
  }
}

/** Sets the lifetime on the member `url`, returning what it was. */
async function setLifetime(url, seconds) {
  const member = new MongoClient(url, { serverSelectionTimeoutMS: 10_000 });
  try {
    const admin = member.db("admin");
    const before = (await admin.command({ getParameter: 1, [PARAMETER]: 1 }))[PARAMETER];
    await admin.command({ setParameter: 1, [PARAMETER]: seconds });
    return before;
  } finally {
    await member.close();
  }
}

/**
 * Runs `run` with the transaction lifetime of every member of the replica set `url` at `seconds`, then sets each
 * member back to the value it had before (also when `run` throws; a failure to restore throws after it, naming the member).
 * @template T
 * @param {string} url
 * @param {number} seconds
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function withTransactionLifetime(url, seconds, run) {
  const changed = [];
  let result;
  let failure;
  try {
    for (const member of await membersOf(url))
      changed.push({ member, before: await setLifetime(member, seconds) });
    result = await run();
  } catch (error) {
    failure = { error };
  }
  const notRestored = [];
  for (const { member, before } of changed)
    try {
      await setLifetime(member, before);
    } catch (error) {
      notRestored.push(`${member}: ${String(error)}`);
    }
  if (failure !== undefined) throw failure.error;
  if (notRestored.length > 0)
    throw new Error(`${PARAMETER} was not put back on ${notRestored.join("; ")}`);
  return result;
}
