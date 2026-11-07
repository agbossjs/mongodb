/**
 * agbossjs/agboss#824 — an application served over A2A on MongoDB alone, for the two-instance test:
 * one start that finishes with its message, every store it needs on the replica set, and an observer
 * that counts the executions every instance starts.
 */
import {
  Application,
  Budget,
  BudgetPeriod,
  BudgetScope,
  Injectable,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  start,
  type BudgetHandler,
  type ExecutionStartEvent,
  type OnExecutionStart,
} from "@agboss/core";
import { A2ACallerResolution, A2AExpose, type A2ACallerResolver } from "@agboss/core/a2a";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { usd, type Usd } from "@agboss/core/units";
import {
  MongoA2ATaskRepository,
  MongoCheckpointSaver,
  MongoConnection,
  MongoExecutionLeaseRepository,
  MongoExecutionRecordRepository,
  MongoExecutionTreeRepository,
  MongoPausedExecutionRepository,
} from "../../src/index.js";
import { A2AEnvironment } from "./environments/app.environment.js";

/** The executions every instance of the test started, by execution id. */
export const started: string[] = [];

@Injectable()
export class StartCounter implements OnExecutionStart {
  onExecutionStart(event: ExecutionStartEvent): void {
    started.push(event.executionId);
  }
}

/** Every caller is alice. */
@Injectable()
export class AliceCallerResolver implements A2ACallerResolver<typeof EchoWorkflowStart> {
  resolveCaller(): A2ACallerResolution<typeof EchoWorkflowStart> {
    return A2ACallerResolution.resolved({ ownerId: "alice" });
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
  flow: [start(EchoWorkflowStart).returns(WorkflowStartTextDto).toFinish(EchoWorkflowFinish)],
})
export class EchoWorkflow {}

@A2AExpose({
  name: "echo-a2a-expose",
  version: "1.0.0",
  description: "Echoes a message",
  exports: [EchoWorkflowStart],
})
export class EchoA2AExpose {}

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

@Application({
  name: "echo-application",
  version: "1.0.0",
  environment: A2AEnvironment,
  workflows: [EchoWorkflow],
  observers: [StartCounter],
  exposes: [EchoA2AExpose],
  budgets: [EchoApplicationBudget, EchoTenantBudget, EchoExecutionBudget],
  providers: [
    AliceCallerResolver,
    MongoConnection,
    MongoA2ATaskRepository,
    MongoCheckpointSaver,
    MongoExecutionLeaseRepository,
    MongoExecutionRecordRepository,
    MongoExecutionTreeRepository,
    MongoPausedExecutionRepository,
  ],
})
export class EchoApplication {}
