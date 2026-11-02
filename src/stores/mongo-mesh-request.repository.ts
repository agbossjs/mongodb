import {
  Injectable,
  MeshRequestRepository,
  type MeshRequestKey,
  type MeshRequestRecord,
} from "@agboss/core";
import type { Collection } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import { idOf } from "./keys.js";

/** One trusted mesh request: its answer as JSON text once it has one (absent while it runs). */
interface MeshRequestDocument {
  _id: string;
  tenantId: string;
  peer: string;
  idempotencyKey: string;
  createdAt: Date;
  response?: string;
}

const Stored = z.object({
  tenantId: z.string(),
  peer: z.string(),
  idempotencyKey: z.string(),
  createdAt: z.date(),
  response: z.string().optional(),
});

const idOfKey = (key: MeshRequestKey): string => idOf(key.tenantId, key.peer, key.idempotencyKey);

/**
 * `MeshRequestRepository` on MongoDB (agbossjs/agboss#483, #527): one document per trusted mesh
 * request, `_id` the receiver's tenant, the peer and the caller's idempotency key. `saveIfAbsent`
 * is one upsert with `$setOnInsert`: of two instances admitting one key — a request retried against
 * another pod — exactly one inserts it and runs it, the other finds it (its answer, or a run still
 * in progress). An answer of JSON `null` is the text `"null"`, told apart from no answer yet (no
 * field). The answer, the forget and the retention sweep are one command each.
 */
@Injectable({ deps: [MongoConnection] })
export class MongoMeshRequestRepository extends MeshRequestRepository {
  constructor(private readonly connection: MongoConnection) {
    super();
  }

  get #requests(): Collection<MeshRequestDocument> {
    return this.connection.db.collection<MeshRequestDocument>(Collections.MeshRequests);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async saveIfAbsent(record: MeshRequestRecord): Promise<boolean> {
    const { tenantId, peer, idempotencyKey } = record;
    const _id = idOfKey(record);
    const document = { _id, tenantId, peer, idempotencyKey, createdAt: new Date(record.createdAt) };
    const saved = await this.#requests.updateOne(
      { _id },
      { $setOnInsert: document },
      { upsert: true },
    );
    return saved.upsertedCount === 1;
  }

  async findByKey(key: MeshRequestKey): Promise<MeshRequestRecord | undefined> {
    const found = await this.#requests.findOne({ _id: idOfKey(key) });
    if (found === null) return undefined;
    const stored = Stored.parse(found);
    return {
      tenantId: stored.tenantId,
      peer: stored.peer,
      idempotencyKey: stored.idempotencyKey,
      createdAt: stored.createdAt.toISOString(),
      ...(stored.response === undefined
        ? {}
        : { response: JSON.parse(stored.response) as unknown }),
    };
  }

  async saveResponse(key: MeshRequestKey, response: unknown): Promise<void> {
    // `JSON.stringify(undefined)` is no text: an answer of nothing is kept as JSON `null`
    const text = response === undefined ? "null" : JSON.stringify(response);
    await this.#requests.updateOne({ _id: idOfKey(key) }, { $set: { response: text } });
  }

  async deleteByKey(key: MeshRequestKey): Promise<void> {
    await this.#requests.deleteOne({ _id: idOfKey(key) });
  }

  async deleteCreatedBefore(cutoff: Date): Promise<void> {
    await this.#requests.deleteMany({ createdAt: { $lt: cutoff } });
  }
}
