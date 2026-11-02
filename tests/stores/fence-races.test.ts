import { FencedEffectSettings } from "@agboss/core";
import { MongoExecutionLeaseRepository, MongoFencedEffectRepository } from "../../src/index.js";
import { fenceRaceCases } from "../contracts/fence-races.js";
import { HandClock } from "../contracts/lease-races.js";
import { instanceConnection } from "../contracts/mongodb-store.js";
import { TestApplicationContext } from "../support/application-context.js";
import { emptyAll, testDatabase } from "../support/database.js";

/** agbossjs/agboss#527: a takeover inside a zombie's open fenced transaction, on MongoDB. */
const database = testDatabase();

fenceRaceCases("MongoDB", async () => {
  await emptyAll(database.url(), ["fence_race_rows"]);
  const clock = new HandClock();
  const one = await instanceConnection(database, "instance-1");
  const two = await instanceConnection(database, "instance-2");
  return {
    first: {
      effects: new MongoFencedEffectRepository(one, clock, new FencedEffectSettings()),
      leases: new MongoExecutionLeaseRepository(
        one,
        clock,
        new TestApplicationContext({}, "instance-1"),
      ),
    },
    second: {
      leases: new MongoExecutionLeaseRepository(
        two,
        clock,
        new TestApplicationContext({}, "instance-2"),
      ),
    },
    advance: (by) => clock.advance(by),
    committed: () => two.db.collection("fence_race_rows").countDocuments(),
  };
});
