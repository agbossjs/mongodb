/**
 * As agbossjs/agboss#511 AC3 for `@agboss/postgres`: `MongoConnection` declares the environment
 * fields it reads (`environmentFields`), so an application that lists it without `mongodbUrl` in
 * its environment contract fails at assembly with `[environment.missing-field]`, naming the field
 * — before any client is built. The assembly reports every violation at once, so an application
 * with no workflow shows its environment's violations too.
 */
import {
  Application,
  Budget,
  BudgetPeriod,
  BudgetScope,
  createApp,
  GraphRuleError,
  type BudgetHandler,
  type Secret,
} from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { MongoConnection } from "../../src/index.js";

@Budget({
  name: "probe-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
class ProbeApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "probe-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
class ProbeTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "probe-execution-budget", scope: BudgetScope.Execution })
class ProbeExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

/** A contract without the connection's fields. */
class UrllessEnvironment {
  region!: string;
}

/** A contract with the required field; the optional ones absent. */
class MongoEnvironment {
  mongodbUrl!: Secret;
}

const BUDGETS = [ProbeApplicationBudget, ProbeTenantBudget, ProbeExecutionBudget];

@Application({
  name: "urlless-application",
  version: "1.0.0",
  environment: UrllessEnvironment,
  workflows: [],
  providers: [MongoConnection],
  budgets: BUDGETS,
})
class UrllessApplication {}

@Application({
  name: "mongodb-application",
  version: "1.0.0",
  environment: MongoEnvironment,
  workflows: [],
  providers: [MongoConnection],
  budgets: BUDGETS,
})
class MongoApplication {}

/** The assembly's violations of the environment contract, as `[code] message`. */
async function environmentViolationsOf(application: new () => object): Promise<string[]> {
  const error: unknown = await createApp(application, { env: "test" }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof GraphRuleError)) throw new Error("expected the assembly to fail");
  return error.violations
    .filter((found) => found.code.startsWith("environment."))
    .map((found) => `[${found.code}] ${found.message}`);
}

describe("mongodbUrl is checked at assembly", () => {
  it("MongoConnection listed without mongodbUrl in the contract → [environment.missing-field]", async () => {
    const violations = await environmentViolationsOf(UrllessApplication);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(
      /^\[environment\.missing-field\] MongoConnection needs mongodbUrl: Secret in UrllessEnvironment/,
    );
  });

  it("mongodbDatabase and mongodbTransactionReadConcern are optional: absent, no violation", async () => {
    expect(await environmentViolationsOf(MongoApplication)).toEqual([]);
  });
});
