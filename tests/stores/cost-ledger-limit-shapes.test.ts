/**
 * The cost ledger's limit as the client sends and reads it (a fake collection, no server): what a save sets and clears.
 */
import { BudgetScope } from "@agboss/core";
import { usd } from "@agboss/core/units";
import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";
import { MongoCostLedgerRepository } from "../../src/index.js";

const dbOf = (collection: object): Db => ({ collection: () => collection }) as never;
const connectionOf = (collection: object) => ({ db: dbOf(collection) }) as never;

const ACCOUNT = { budget: "b", scope: BudgetScope.Tenant, key: "default" };

/** A collection that records every `updateOne` as `[filter, update, options]`. */
function updating() {
  const calls: unknown[][] = [];
  const collection = {
    updateOne: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ matchedCount: 1, upsertedCount: 0 });
    },
  };
  return { collection, calls };
}

describe("the cost ledger's limit: what a save sets and clears, what a read answers", () => {
  const saved = async (limit: { maxSpend?: ReturnType<typeof usd>; maxTokens?: number }) => {
    const { collection, calls } = updating();
    await new MongoCostLedgerRepository(connectionOf(collection)).saveLimit(ACCOUNT, limit);
    return calls[0]?.[1];
  };

  it("both limits are set, nothing is cleared", async () => {
    expect(await saved({ maxSpend: usd(5), maxTokens: 100 })).toStrictEqual({
      $set: { maxSpendUsd: 5, maxTokens: 100 },
      $unset: {},
    });
  });

  it("a USD-only limit sets the spend and clears the tokens, never one as the other", async () => {
    expect(await saved({ maxSpend: usd(5) })).toStrictEqual({
      $set: { maxSpendUsd: 5 },
      $unset: { maxTokens: "" },
    });
  });

  it("a token-only limit sets the tokens and clears the spend", async () => {
    expect(await saved({ maxTokens: 100 })).toStrictEqual({
      $set: { maxTokens: 100 },
      $unset: { maxSpendUsd: "" },
    });
  });

  it("no limit at all sets nothing and clears both", async () => {
    expect(await saved({})).toStrictEqual({ $unset: { maxSpendUsd: "", maxTokens: "" } });
  });

  it("reads back only the limits the document holds", async () => {
    const found = (document: object) =>
      new MongoCostLedgerRepository(
        connectionOf({ findOne: () => Promise.resolve({ _id: "x", ...document }) }),
      ).findLimitByAccount(ACCOUNT);

    expect(await found({ maxSpendUsd: 5, maxTokens: 100 })).toStrictEqual({
      maxSpend: 5,
      maxTokens: 100,
    });
    expect(await found({ maxSpendUsd: 5 })).toStrictEqual({ maxSpend: 5 });
    expect(await found({ maxTokens: 100 })).toStrictEqual({ maxTokens: 100 });
  });
});
