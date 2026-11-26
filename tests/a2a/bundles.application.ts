import { Application } from "@agboss/core";
import {
  EchoApplicationBudget,
  EchoDatabaseStorage,
  EchoExecutionBudget,
  EchoTenantBudget,
  EchoWorkflow,
} from "./a2a.application.js";

/**
 * agbossjs/agboss#891 AC3, on the storage of agbossjs/agboss#1321: an application whose stores are
 * the package's whole bundle (`MONGODB_STORES`) — `MongoDriver` of its `@DatabaseStorage` provides
 * them; listing one in `providers` beside a storage is `[storage.providers-conflict]` — on the tests'
 * one workflow (`a2a.application.ts`).
 */

const BUDGETS = [EchoApplicationBudget, EchoTenantBudget, EchoExecutionBudget];

@Application({
  name: "mongodb-stores-application",
  version: "1.0.0",
  storage: EchoDatabaseStorage,
  workflows: [EchoWorkflow],
  budgets: BUDGETS,
})
export class MongoStoresApplication {}
