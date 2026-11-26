/**
 * agbossjs/agboss#824 — an application served over A2A on MongoDB alone, for the two-instance test:
 * one start that finishes with its message, every store it needs on the replica set (its
 * `@DatabaseStorage`), and an observer that counts the executions every instance starts.
 */
import {
  Application,
  Budget,
  BudgetPeriod,
  BudgetScope,
  DatabaseStorage,
  HttpAuthenticator,
  HttpAuthResult,
  Observer,
  onStart,
  secret,
  Ttl,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type BudgetHandler,
  type ExecutionStartEvent,
} from "@agboss/core";
import { A2AEndpoint } from "@agboss/core/a2a";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { hours, minutes, usd, type Usd } from "@agboss/core/units";
import { MongoDriver } from "../../src/index.js";
import { StopBatchWorkflow, StopItemWorkflow } from "../fixtures/stop/stop.application.js";

/** The executions every instance of the test started, by execution id. */
export const started: string[] = [];

@Observer()
export class StartCounter {
  onExecutionStart(event: ExecutionStartEvent): void {
    started.push(event.executionId);
  }
}

/** Every caller is alice. */
@HttpAuthenticator({ name: "alice-http-authenticator", description: "Every caller is alice" })
export class AliceAuthenticator {
  authenticate(): HttpAuthResult {
    return HttpAuthResult.authenticated({ ownerId: "alice" });
  }
}

@WorkflowStart({
  name: "echo-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class EchoWorkflowStart {}

@WorkflowFinish({
  name: "echo-workflow-finish",
  description: "The message, as it came",
  output: WorkflowStartTextDto,
})
export class EchoWorkflowFinish {}

@Workflow({
  name: "echo-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(EchoWorkflowStart).toFinish(EchoWorkflowFinish)],
})
export class EchoWorkflow {}

@A2AEndpoint({
  name: "echo-a2a-endpoint",
  version: "1.0.0",
  description: "Echoes a message",
  ttl: { tasks: hours(24), messages: minutes(15) },
  skills: [{ start: EchoWorkflowStart, tags: ["echo"] }],
})
export class EchoA2AEndpoint {}

@Budget({
  name: "echo-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
export class EchoApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "echo-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class EchoTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "echo-execution-budget", scope: BudgetScope.Execution })
export class EchoExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

/**
 * Every row on the test's replica set: the URL its test sets in the variable before an instance
 * starts.
 */
@DatabaseStorage({
  name: "echo-database-storage",
  description: "The two-instance A2A test's MongoDB replica set",
  driver: MongoDriver({ url: secret("AGBOSS_A2A_TEST_MONGODB_URL") }),
  auditLogTtl: hours(24),
  ledgerEntriesTtl: hours(24),
})
export class EchoDatabaseStorage {}

@Application({
  name: "echo-application",
  version: "1.0.0",
  storage: EchoDatabaseStorage,
  workflows: [EchoWorkflow],
  observers: [StartCounter],
  endpoints: [EchoA2AEndpoint],
  budgets: [EchoApplicationBudget, EchoTenantBudget, EchoExecutionBudget],
  providers: [AliceAuthenticator],
})
export class EchoApplication {}

// `agboss check` types the workflows the application module exports (.agboss/types.d.ts), the
// stop tests' (`tests/fixtures/stop/`) included
export { StopBatchWorkflow, StopItemWorkflow };
