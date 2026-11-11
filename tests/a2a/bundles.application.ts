import {
  ApplicationContext,
  Application,
  EXECUTION_ID_STORE,
  Injectable,
  provide,
  StoreClock,
  type ExecutionIdentity,
  type ExecutionIdStore,
  type StoreDescriptor,
} from "@agboss/core";
import {
  MongoConnection,
  MongoExecutionLeaseRepository,
  MONGODB_DURABLE_STORES,
  MONGODB_STORES,
} from "../../src/index.js";
import {
  EchoApplicationBudget,
  EchoExecutionBudget,
  EchoTenantBudget,
  EchoWorkflow,
} from "./a2a.application.js";
import { A2AEnvironment } from "./environments/app.environment.js";

/**
 * agbossjs/agboss#891 AC3 — the two bundles in an application's providers: the whole package
 * (`MONGODB_STORES`), and the durable stores beside a coordination lease store
 * (`MONGODB_DURABLE_STORES`, a lease store of the backend "redis" as `@agboss/redis`'s, its ids
 * kept by `provide(EXECUTION_ID_STORE, MongoExecutionLeaseRepository)`) — on the tests' one
 * workflow (`a2a.application.ts`).
 */

const BUDGETS = [EchoApplicationBudget, EchoTenantBudget, EchoExecutionBudget];

/** Leases of another backend (as Redis's): its ids kept by the durable store under the token. */
@Injectable({ deps: [MongoConnection, StoreClock, ApplicationContext, EXECUTION_ID_STORE] })
export class CoordinationLeases extends MongoExecutionLeaseRepository {
  static override readonly store: StoreDescriptor = { backend: "redis" };

  constructor(
    connection: MongoConnection,
    clock: StoreClock,
    applicationContext: ApplicationContext,
    private readonly ids: ExecutionIdStore,
  ) {
    super(connection, clock, applicationContext);
  }

  override claimExecutionId(identity: ExecutionIdentity): Promise<boolean> {
    return this.ids.claimExecutionId(identity);
  }
}

@Application({
  name: "mongodb-stores-application",
  version: "1.0.0",
  environment: A2AEnvironment,
  workflows: [EchoWorkflow],
  providers: [...MONGODB_STORES],
  budgets: BUDGETS,
})
export class MongoStoresApplication {}

@Application({
  name: "mongodb-durable-stores-application",
  version: "1.0.0",
  environment: A2AEnvironment,
  workflows: [EchoWorkflow],
  providers: [
    ...MONGODB_DURABLE_STORES,
    CoordinationLeases,
    provide(EXECUTION_ID_STORE, MongoExecutionLeaseRepository),
  ],
  budgets: BUDGETS,
})
export class MongoDurableStoresApplication {}
