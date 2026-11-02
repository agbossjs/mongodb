import { MongoExecutionLeaseRepository } from "../../src/index.js";
import { HandClock, leaseRaceCases } from "../contracts/lease-races.js";
import { instanceConnection } from "../contracts/mongodb-store.js";
import { TestApplicationContext } from "../support/application-context.js";
import { emptyAll, testDatabase } from "../support/database.js";

/** agbossjs/agboss#527: two instances' takes of one free lease at once, on MongoDB — exactly one wins. */
const database = testDatabase();

leaseRaceCases("MongoDB", async () => {
  await emptyAll(database.url());
  const clock = new HandClock();
  const leasesOf = async (instanceId: string): Promise<MongoExecutionLeaseRepository> =>
    new MongoExecutionLeaseRepository(
      await instanceConnection(database, instanceId),
      clock,
      new TestApplicationContext({}, instanceId),
    );
  return {
    first: await leasesOf("instance-1"),
    second: await leasesOf("instance-2"),
    advance: (by) => clock.advance(by),
  };
});
