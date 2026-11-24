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
import { parsedOrUnreadable } from "./unreadable.js";

/** One trusted mesh request: its answer as JSON text once it has one (absent while it runs). */
interface MeshRequestDocument {
  _id: string;
  tenantId: string;
  peer: string;
  idempotencyKey: string;
  /** What the request asked: a repeat of the key naming another tool or arguments is another request. */
  tool: string;
  requestHash: string;
  createdAt: Date;
  /** Until when its answer is kept: what the sweep reads. */
  expiresAt: Date;
  /** The attempt that owns the request while it runs: only it may answer, renew or forget it. */
  attemptId: string;
  /** Until when that attempt holds the request: the running handler renews it. */
  lockedUntil: Date;
  response?: string;
}

const Stored = z.object({
  tenantId: z.string(),
  peer: z.string(),
  idempotencyKey: z.string(),
  tool: z.string(),
  requestHash: z.string(),
  createdAt: z.date(),
  expiresAt: z.date(),
  attemptId: z.string(),
  lockedUntil: z.date(),
  response: z.string().optional(),
});

/** An answer as kept: `JSON.stringify(undefined)` is no text, so nothing is kept as JSON `null`. */
const textOf = (response: unknown): string =>
  response === undefined ? "null" : JSON.stringify(response);

const idOfKey = (key: MeshRequestKey): string => idOf(key.tenantId, key.peer, key.idempotencyKey);

/**
 * `MeshRequestRepository` on MongoDB (agbossjs/agboss#483, #527): one document per trusted mesh
 * request, `_id` the receiver's tenant, the peer and the caller's idempotency key. `saveIfAbsent`
 * is one upsert with `$setOnInsert`: of two instances admitting one key — a request retried against
 * another pod — exactly one inserts it and runs it, the other finds it (its answer, or a run still
 * in progress). An answer of JSON `null` is the text `"null"`, told apart from no answer yet (no
 * field). A running request is held by an attempt under a lease (`attemptId`, `lockedUntil`, #1319c):
 * the answer, the renewal and the forget are one conditional command each, matched by the attempt —
 * a stale attempt is fenced; the retention sweep reads `expiresAt`.
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

  /**
   * Claims the request for `record.attemptId` (#1319c), atomically: a key not kept yet is inserted
   * (one upsert with `$setOnInsert`, with its answer when the record has one); a key kept without an
   * answer whose lease lapsed (`lockedUntil <= record.createdAt`) is taken over — one conditional
   * update, only by the same tool and request hash; a live lease, an answered request or another
   * request under the key is `false`.
   */
  async saveIfAbsent(record: MeshRequestRecord): Promise<boolean> {
    const { tenantId, peer, idempotencyKey, tool, requestHash, attemptId } = record;
    const _id = idOfKey(record);
    const createdAt = new Date(record.createdAt);
    const lockedUntil = new Date(record.lockedUntil);
    const document: MeshRequestDocument = {
      ...{ _id, tenantId, peer, idempotencyKey, tool, requestHash, createdAt, attemptId },
      ...{ expiresAt: new Date(record.expiresAt), lockedUntil },
      ...(record.response === undefined ? {} : { response: textOf(record.response) }),
    };
    const saved = await this.#requests.updateOne(
      { _id },
      { $setOnInsert: document },
      { upsert: true },
    );
    if (saved.upsertedCount === 1) return true;
    const taken = await this.#requests.updateOne(
      { _id, response: { $exists: false }, lockedUntil: { $lte: createdAt }, tool, requestHash },
      { $set: { attemptId, createdAt, lockedUntil } },
    );
    return taken.matchedCount === 1;
  }

  async findByKey(key: MeshRequestKey): Promise<MeshRequestRecord | undefined> {
    const found = await this.#requests.findOne({ _id: idOfKey(key) });
    if (found === null) return undefined;
    const stored = Stored.parse(found);
    return {
      tenantId: stored.tenantId,
      peer: stored.peer,
      idempotencyKey: stored.idempotencyKey,
      tool: stored.tool,
      requestHash: stored.requestHash,
      createdAt: stored.createdAt.toISOString(),
      expiresAt: stored.expiresAt.toISOString(),
      attemptId: stored.attemptId,
      lockedUntil: stored.lockedUntil.toISOString(),
      ...(stored.response === undefined
        ? {}
        : {
            response: parsedOrUnreadable("mesh request response", stored.response, {
              peer: stored.peer,
              idempotencyKey: stored.idempotencyKey,
            }),
          }),
    };
  }

  /** Extends the lease of the attempt that holds `key`: `false` (fenced) for another attempt, an answered request or none. */
  async renewLease(key: MeshRequestKey, attemptId: string, lockedUntil: string): Promise<boolean> {
    const renewed = await this.#requests.updateOne(
      { _id: idOfKey(key), attemptId, response: { $exists: false } },
      { $set: { lockedUntil: new Date(lockedUntil) } },
    );
    return renewed.matchedCount === 1;
  }

  /** Keeps the answer of the request `attemptId` holds: `false` (nothing written) for another attempt, an answered request or none. */
  async saveResponse(key: MeshRequestKey, attemptId: string, response: unknown): Promise<boolean> {
    const saved = await this.#requests.updateOne(
      { _id: idOfKey(key), attemptId, response: { $exists: false } },
      { $set: { response: textOf(response) } },
    );
    return saved.matchedCount === 1;
  }

  /** Forgets a request whose run did not answer, if `attemptId` still holds it. */
  async deleteByKey(key: MeshRequestKey, attemptId: string): Promise<boolean> {
    const removed = await this.#requests.deleteOne({ _id: idOfKey(key), attemptId });
    return removed.deletedCount === 1;
  }

  /**
   * Removes every request whose `expiresAt` is at or before `now` and that is answered or whose
   * lease lapsed (`lockedUntil <= now`): a running request whose handler keeps renewing is never
   * removed. How many went.
   */
  async deleteExpired(now: Date): Promise<number> {
    const removed = await this.#requests.deleteMany({
      expiresAt: { $lte: now },
      $or: [{ response: { $exists: true } }, { lockedUntil: { $lte: now } }],
    });
    return removed.deletedCount;
  }
}
