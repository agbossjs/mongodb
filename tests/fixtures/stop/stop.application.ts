import {
  Action,
  Application,
  Budget,
  BudgetPeriod,
  BudgetScope,
  ChildPlacement,
  ExecutionContext,
  listOf,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type BudgetHandler,
  type Produced,
} from "@agboss/core";
import { Text } from "@agboss/core/dto";
import { usd, type Usd } from "@agboss/core/units";
import {
  MongoChildExecutionQueueRepository,
  MongoConnection,
  MongoCostLedgerRepository,
  MongoExecutionAuditLogRepository,
  MongoExecutionHistoryRepository,
  MongoExecutionLeaseRepository,
  MongoExecutionRecordRepository,
  MongoExecutionTreeRepository,
  MongoFencedEffectRepository,
  MongoOutboundCallRepository,
  MongoPausedExecutionRepository,
  MongoRateLimitRepository,
  MongoCheckpointSaver,
} from "../../../src/index.js";
import { start } from "./untyped-flow.js";
import { StopEnvironment } from "./environments/stop.contract.js";

/**
 * agbossjs/agboss#954 — an application of the stop tests: a recount whose items run as children on
 * any instance (so the child workers and the queue's watch run), each held at a gate the test
 * never opens; every store is on MongoDB.
 */

export class ItemDto {
  @Text({ prompt: "the item's name" })
  name!: string;
}

export class SummaryDto {
  @Text({ prompt: "what was done" })
  text!: string;
}

/** The held steps: until the signal aborts they wait. */
@Action({
  name: "stop-hold-action",
  description: "Holds its step until the run is stopped",
  input: { item: ItemDto },
  output: ItemDto,
  deps: [ExecutionContext],
})
export class StopHoldAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<ItemDto> {
    const { signal } = this.executionContext;
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        reject(new Error(`${input.item.value.name} stopped`));
      });
    });
  }
}

@WorkflowStart({ name: "stop-item-workflow-start", description: "One item", input: ItemDto })
export class StopItemStart {}

@WorkflowFinish({ name: "stop-item-workflow-finish", description: "Checked", output: ItemDto })
export class StopItemFinish {}

@Workflow({
  name: "stop-item-workflow",
  version: "1.0.0",
  flow: [
    start(StopItemStart)
      .returns(ItemDto)
      .toAction(StopHoldAction)
      .returns(ItemDto)
      .toFinish(StopItemFinish),
  ],
})
export class StopItemWorkflow {}

@WorkflowStart({
  name: "stop-batch-workflow-start",
  description: "Items, each a child on any instance",
  input: listOf(ItemDto),
})
export class StopBatchStart {}

@WorkflowFinish({
  name: "stop-batch-workflow-finish",
  description: "What was checked",
  input: { results: listOf(ItemDto) },
  output: SummaryDto,
})
export class StopBatchFinish {
  finish(input: { readonly results: readonly Produced<ItemDto, unknown>[] }): SummaryDto {
    return { text: input.results.map((result) => result.value.name).join(", ") };
  }
}

@Workflow({
  name: "stop-batch-workflow",
  version: "1.0.0",
  maxConcurrentExecutions: 30,
  flow: [
    start(StopBatchStart)
      .returns(listOf(ItemDto))
      .toParallelWorkflows(StopItemWorkflow, {
        maxConcurrency: 4,
        maxItems: 4,
        placement: ChildPlacement.AnyInstance,
      })
      .join()
      .returns(listOf(ItemDto))
      .toFinish(StopBatchFinish),
  ],
})
export class StopBatchWorkflow {}

@Budget({
  name: "stop-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
export class StopApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "stop-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class StopTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "stop-execution-budget", scope: BudgetScope.Execution })
export class StopExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.05);
  }
}

/** Every store on MongoDB; the child workers and the queue's change stream run on any instance. */
@Application({
  name: "stop-application",
  version: "1.0.0",
  environment: StopEnvironment,
  workflows: [StopBatchWorkflow, StopItemWorkflow],
  budgets: [StopApplicationBudget, StopTenantBudget, StopExecutionBudget],
  providers: [
    MongoConnection,
    MongoCheckpointSaver,
    MongoChildExecutionQueueRepository,
    MongoCostLedgerRepository,
    MongoExecutionHistoryRepository,
    MongoExecutionAuditLogRepository,
    MongoExecutionLeaseRepository,
    MongoExecutionRecordRepository,
    MongoExecutionTreeRepository,
    MongoFencedEffectRepository,
    MongoOutboundCallRepository,
    MongoPausedExecutionRepository,
    MongoRateLimitRepository,
  ],
})
export class StopApplication {}
