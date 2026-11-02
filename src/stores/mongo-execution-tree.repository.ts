import {
  ExecutionTreeRepository,
  Injectable,
  type ExecutionTree,
  type ExecutionTreeValue,
} from "@agboss/core";
import type { Collection } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import { idOf } from "./keys.js";

/** A stored value as JSON gives it back: what `saveIfAbsentInTree` wrote. */
const TreeValue: z.ZodType<ExecutionTreeValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(TreeValue),
    z.record(z.string(), TreeValue),
  ]),
);

/** One key of a tree: its value as JSON text (a key of an object may hold anything, U+0000 too). */
interface TreeKeyDocument {
  _id: string;
  tenantId: string;
  rootExecutionId: string;
  value: string;
}

const Stored = z.object({ value: z.string() });

/**
 * `ExecutionTreeRepository` on MongoDB (#265, agbossjs/agboss#527): one document per key of a tree,
 * `_id` its tenant, root and key. `saveIfAbsentInTree` is one upsert with `$setOnInsert`, so of two
 * instances saving one key exactly one inserts it (`true`); the other finds it (`false`).
 */
@Injectable({ deps: [MongoConnection] })
export class MongoExecutionTreeRepository extends ExecutionTreeRepository {
  constructor(private readonly connection: MongoConnection) {
    super();
  }

  get #keys(): Collection<TreeKeyDocument> {
    return this.connection.db.collection<TreeKeyDocument>(Collections.ExecutionTreeKeys);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async saveIfAbsentInTree(
    tree: ExecutionTree,
    key: string,
    value: ExecutionTreeValue,
  ): Promise<boolean> {
    const { tenantId, rootExecutionId } = tree;
    const _id = idOf(tenantId, rootExecutionId, key);
    const saved = await this.#keys.updateOne(
      { _id },
      { $setOnInsert: { _id, tenantId, rootExecutionId, value: JSON.stringify(value) } },
      { upsert: true },
    );
    return saved.upsertedCount === 1;
  }

  async findByIdInTree(tree: ExecutionTree, key: string): Promise<ExecutionTreeValue | undefined> {
    const found = await this.#keys.findOne({ _id: idOf(tree.tenantId, tree.rootExecutionId, key) });
    return found === null ? undefined : TreeValue.parse(JSON.parse(Stored.parse(found).value));
  }

  async deleteAllInTree(tree: ExecutionTree): Promise<void> {
    await this.#keys.deleteMany({ tenantId: tree.tenantId, rootExecutionId: tree.rootExecutionId });
  }
}
