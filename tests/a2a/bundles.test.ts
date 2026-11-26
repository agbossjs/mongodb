import {
  CostLedgerRepository,
  createApp,
  ExecutionLeaseRepository,
  FencedEffectRepository,
  OutboundCallRepository,
  type App,
} from "@agboss/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  MONGODB_DURABLE_STORES,
  MONGODB_STORES,
  MongoCostLedgerRepository,
  MongoExecutionLeaseRepository,
  MongoFencedEffectRepository,
  MongoOutboundCallRepository,
} from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { MongoStoresApplication } from "./bundles.application.js";

/**
 * agbossjs/agboss#891 AC3 — the bundles' lists, and an application on `MongoDriver` (which provides
 * `MONGODB_STORES`) starting on the test's migrated database, every contract on its MongoDB store.
 */
const database = testDatabase();
const started: App[] = [];

afterEach(async () => {
  for (const app of started.splice(0)) await app.close();
});

async function start(application: new () => object): Promise<App> {
  process.env.AGBOSS_A2A_TEST_MONGODB_URL = database.url();
  const app = await createApp(application);
  started.push(app);
  return app;
}

describe("agbossjs/agboss#891 AC3: the store bundles", () => {
  it("AC3: MONGODB_STORES lists every store once; the durable ones leave out the coordination and fencing stores", () => {
    expect(new Set(MONGODB_STORES).size).toBe(15);
    expect(MONGODB_STORES).toEqual(expect.arrayContaining([...MONGODB_DURABLE_STORES]));
    expect(MONGODB_DURABLE_STORES).toHaveLength(10);
    expect(MONGODB_DURABLE_STORES).not.toEqual(
      expect.arrayContaining([MongoExecutionLeaseRepository]),
    );
    expect(MONGODB_DURABLE_STORES).not.toEqual(
      expect.arrayContaining([MongoFencedEffectRepository]),
    );
    expect(MONGODB_DURABLE_STORES).not.toEqual(
      expect.arrayContaining([MongoOutboundCallRepository]),
    );
  });

  it("AC3: an application on MongoDriver starts, every contract on its MongoDB store", async () => {
    const app = await start(MongoStoresApplication);

    expect(app.resolve(ExecutionLeaseRepository)).toBeInstanceOf(MongoExecutionLeaseRepository);
    expect(app.resolve(FencedEffectRepository)).toBeInstanceOf(MongoFencedEffectRepository);
    expect(app.resolve(OutboundCallRepository)).toBeInstanceOf(MongoOutboundCallRepository);
    expect(app.resolve(CostLedgerRepository)).toBeInstanceOf(MongoCostLedgerRepository);
  });
});
