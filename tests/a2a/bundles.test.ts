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
import {
  CoordinationLeases,
  MongoDurableStoresApplication,
  MongoStoresApplication,
} from "./bundles.application.js";

/**
 * agbossjs/agboss#891 AC3 — `MONGODB_STORES` and `MONGODB_DURABLE_STORES` in `providers`: each
 * application starts on the test's migrated database, every contract on the store listed.
 */
const database = testDatabase();
const started: App[] = [];

afterEach(async () => {
  for (const app of started.splice(0)) await app.close();
});

async function start(application: new () => object): Promise<App> {
  process.env.AGBOSS_A2A_TEST_MONGODB_URL = database.url();
  const app = await createApp(application, { env: "instances" });
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

  it("AC3: an application on MONGODB_STORES starts, every contract on its MongoDB store", async () => {
    const app = await start(MongoStoresApplication);

    expect(app.resolve(ExecutionLeaseRepository)).toBeInstanceOf(MongoExecutionLeaseRepository);
    expect(app.resolve(FencedEffectRepository)).toBeInstanceOf(MongoFencedEffectRepository);
    expect(app.resolve(OutboundCallRepository)).toBeInstanceOf(MongoOutboundCallRepository);
    expect(app.resolve(CostLedgerRepository)).toBeInstanceOf(MongoCostLedgerRepository);
  });

  it("AC3: MONGODB_DURABLE_STORES beside coordination leases and provide(EXECUTION_ID_STORE, MongoExecutionLeaseRepository): no ambiguity, no mismatch", async () => {
    const app = await start(MongoDurableStoresApplication);
    const leases = app.resolve(ExecutionLeaseRepository);
    const identity = { tenantId: "t1", executionId: "e-891-bundles" };

    expect(leases).toBeInstanceOf(CoordinationLeases);
    expect(app.resolve(CostLedgerRepository)).toBeInstanceOf(MongoCostLedgerRepository);
    expect(await leases.claimExecutionId(identity)).toBe(true);
    expect(await leases.claimExecutionId(identity)).toBe(false);
  });
});
