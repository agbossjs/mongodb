import type { Db, IndexDescription } from "mongodb";
import { z } from "zod";
import { MongoCollationError } from "../errors.js";
import { Collections, type CollectionName } from "./collections.js";

/**
 * The stores' collections and indexes (agbossjs/agboss#527), made at the connection's start —
 * idempotent, so every instance of an application runs it and none waits for a migration. Each
 * collection is created with the simple collation; one an operator made with another collation
 * (`{ locale: "en", strength: 2 }` would make `Zoë-17` and `zoe-17` one key, a second charge) is
 * refused with `MongoCollationError` before any store writes. A unique key is always `_id` or a
 * unique index here, never a check in the code.
 */

const ascending = (...fields: readonly string[]): Record<string, 1> =>
  Object.fromEntries(fields.map((field) => [field, 1 as const]));

const index = (name: string, key: Record<string, 1 | -1>, unique = false): IndexDescription => ({
  name,
  key,
  ...(unique ? { unique: true } : {}),
});

/** The secondary indexes of each collection (its `_id` is the primary key). */
const INDEXES: Readonly<Partial<Record<CollectionName, readonly IndexDescription[]>>> = {
  [Collections.FencedEffectMarks]: [index("by_stored_at", ascending("storedAt"))],
  [Collections.FencedEffectResults]: [index("by_stored_at", ascending("storedAt"))],
  [Collections.OutboundCalls]: [
    index("by_tree", ascending("tenantId", "rootExecutionId", "seq")),
    index("by_status", ascending("tenantId", "status", "seq")),
    index("by_ended_at", ascending("endedAt")),
  ],
  [Collections.ExecutionLeaseEvents]: [
    index("by_tree", ascending("tenantId", "rootExecutionId", "occurredAt", "_id")),
    index("by_occurred_at", ascending("occurredAt")),
  ],
  [Collections.ExecutionRecords]: [
    index("by_seq", ascending("seq"), true),
    index("by_thread", ascending("tenantId", "threadId", "seq")),
    index("by_status", ascending("status", "seq")),
    index("by_version", ascending("bundle", "promptVersion", "seq")),
    index("by_workflow", ascending("bundle", "seq")),
  ],
  [Collections.ExecutionScores]: [index("by_record", ascending("recordId"))],
  [Collections.ExecutionSummaries]: [
    index("by_thread", ascending("tenantId", "threadId", "compaction", "toSeq")),
  ],
  [Collections.PauseAnswers]: [
    index("by_tree", ascending("tenantId", "rootExecutionId", "askedAt", "seq")),
  ],
  [Collections.ExecutionTreeKeys]: [index("by_tree", ascending("tenantId", "rootExecutionId"))],
  [Collections.Pauses]: [
    index("by_step", ascending("tenantId", "rootExecutionId", "stepKey"), true),
    index("by_tree", ascending("tenantId", "rootExecutionId", "seq")),
    index("by_resolution", ascending("status", "resolvedAt")),
  ],
  [Collections.ChildExecutionQueue]: [
    index("by_claim", { status: 1, depth: -1, queuedAt: 1 }),
    index("by_tree", ascending("tenantId", "rootExecutionId")),
  ],
  [Collections.ExecutionHistory]: [
    index("by_execution", ascending("executionId", "startedAt")),
    index("by_thread", ascending("tenantId", "threadId", "startedAt")),
    index("by_tenant_start", ascending("tenantId", "startedAt", "executionId")),
    index("by_start", ascending("startedAt", "executionId")),
    index("by_ended_at", ascending("endedAt")),
  ],
  [Collections.MeshRequests]: [index("by_created_at", ascending("createdAt"))],
  [Collections.Checkpoints]: [
    index("by_thread", { threadId: 1, namespace: 1, checkpointId: -1 }),
    index("by_checkpoint", { checkpointId: -1 }),
  ],
  [Collections.CheckpointWrites]: [
    index("by_checkpoint", ascending("threadId", "namespace", "checkpointId", "seq", "position")),
  ],
};

const CollectionInfo = z.object({
  name: z.string(),
  options: z.object({ collation: z.object({ locale: z.string() }).loose().optional() }).loose(),
});

/** The collections that exist with a collation other than the simple one. */
async function collatedCollectionsOf(db: Db): Promise<string[]> {
  const names: string[] = Object.values(Collections);
  const found = await db.listCollections({ name: { $in: names } }).toArray();
  return found
    .map((info) => CollectionInfo.parse(info))
    .filter((info) => (info.options.collation?.locale ?? "simple") !== "simple")
    .map((info) => info.name);
}

/** Creates `name` with the simple collation unless it exists. */
async function createIfMissing(db: Db, name: string, existing: ReadonlySet<string>): Promise<void> {
  if (existing.has(name)) return;
  try {
    await db.createCollection(name, { collation: { locale: "simple" } });
  } catch (error) {
    // another instance created it in between (NamespaceExists): it is there, as wanted
    if (z.object({ code: z.literal(48) }).safeParse(error).success) return;
    throw error;
  }
}

/**
 * Every collection and index of the stores, made if missing; a collection with a non-simple
 * collation fails with `MongoCollationError`, naming it.
 */
export async function ensureSchema(db: Db): Promise<void> {
  const collated = await collatedCollectionsOf(db);
  if (collated.length > 0) throw new MongoCollationError(collated);
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((info) => info.name),
  );
  for (const name of Object.values(Collections)) {
    await createIfMissing(db, name, existing);
    const indexes = INDEXES[name];
    if (indexes !== undefined) await db.collection(name).createIndexes([...indexes]);
  }
}
