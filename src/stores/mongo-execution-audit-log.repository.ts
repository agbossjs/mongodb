import {
  ExecutionAuditLogRepository,
  Injectable,
  type ExecutionAuditEventRecord,
} from "@agboss/core";
import type { Collection } from "mongodb";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import { auditEventOf } from "./audit-log/audit-event-documents.js";
import { nextSequence } from "./sequence.js";

/** One event of the audit log: the record's JSON beside what it is found and ordered by. */
interface AuditEventDocument {
  _id: number;
  tenantId: string;
  rootExecutionId: string;
  occurredAt: Date;
  record: string;
}

/**
 * `ExecutionAuditLogRepository` on MongoDB (#501, agbossjs/agboss#527): the append-only lease
 * log, one document per takeover, hand-over, fenced effect call or outbound call move — its record
 * as JSON text beside the fields it is found by. `save` is one insert (documents are never
 * changed), its `_id` the next number of the log's sequence; a tree's events are read oldest first
 * by `occurredAt`, events of one moment by that number — the order they were saved in, whichever
 * instance saved them. The log is never written inside a lease's transaction (the framework writes
 * it after the move it records). The sweep is one `deleteMany` on the `Clock`'s cutoff.
 */
@Injectable({ deps: [MongoConnection] })
export class MongoExecutionAuditLogRepository extends ExecutionAuditLogRepository {
  constructor(private readonly connection: MongoConnection) {
    super();
  }

  get #events(): Collection<AuditEventDocument> {
    return this.connection.db.collection<AuditEventDocument>(Collections.ExecutionAuditLog);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async save(record: ExecutionAuditEventRecord): Promise<void> {
    const seq = await nextSequence(this.connection.db, Collections.ExecutionAuditLog);
    await this.#events.insertOne({
      _id: seq,
      tenantId: record.tenantId,
      rootExecutionId: record.rootExecutionId,
      occurredAt: new Date(record.occurredAt),
      record: JSON.stringify(record),
    });
  }

  async findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly ExecutionAuditEventRecord[]> {
    const found = await this.#events
      .find({ tenantId, rootExecutionId })
      .sort({ occurredAt: 1, _id: 1 })
      .toArray();
    return found.map(auditEventOf);
  }

  async deleteByOccurredAtBefore(cutoff: Date): Promise<void> {
    await this.#events.deleteMany({ occurredAt: { $lt: cutoff } });
  }
}
