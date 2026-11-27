/**
 * agbossjs/agboss#1317c: the transaction of the `runOnce` a caller is inside of (no server): per
 * connection, the innermost of nested ones, refused outside any with the typed error and its message.
 */
import { IdempotencyError } from "@agboss/core";
import { describe, expect, it } from "vitest";
import {
  requireMongoTransaction,
  requiredTransaction,
  withAmbientTransaction,
} from "../../src/connection/ambient.js";

const transaction = (name: string) => ({ db: name, session: name }) as never;

describe("the ambient transaction", () => {
  it("is the one the work was given, for the owner it was given for, through everything the work awaits", async () => {
    const owner = {};
    const mine = transaction("mine");

    const seen = await withAmbientTransaction(owner, mine, async () => {
      await Promise.resolve();
      return [requiredTransaction(owner), requireMongoTransaction()];
    });

    expect(seen[0]).toBe(mine);
    expect(seen[1]).toBe(mine);
  });

  it("is another connection's own for each owner when runs nest, the innermost for the one asked on any", async () => {
    const [first, second] = [{}, {}];
    const [outer, inner] = [transaction("outer"), transaction("inner")];

    const seen = await withAmbientTransaction(first, outer, () =>
      withAmbientTransaction(second, inner, () =>
        Promise.resolve([
          requiredTransaction(first),
          requiredTransaction(second),
          requireMongoTransaction(),
        ]),
      ),
    );

    expect(seen).toStrictEqual([outer, inner, inner]);
  });

  it("an owner that has none is refused even inside another's run", async () => {
    await withAmbientTransaction({}, transaction("other"), () => {
      expect(() => requiredTransaction({})).toThrow(IdempotencyError.OutsideTransaction);
      return Promise.resolve();
    });
  });

  it("is refused outside a run, naming what to do", () => {
    expect(() => requiredTransaction({})).toThrowError(
      new IdempotencyError.OutsideTransaction({
        message:
          "requireTransaction() was called outside an Idempotency.runOnce on this connection: a repository takes the effect's transaction only inside `execute`, with a MongoDB fenced-effect store listed",
      }),
    );
    expect(() => requireMongoTransaction()).toThrow(IdempotencyError.OutsideTransaction);
  });

  it("outside a run it is gone again once the work has ended", async () => {
    const owner = {};

    await withAmbientTransaction(owner, transaction("t"), () => Promise.resolve());

    expect(() => requiredTransaction(owner)).toThrow(IdempotencyError.OutsideTransaction);
  });
});
