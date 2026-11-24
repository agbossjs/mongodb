import { ExecutionHistoryRepository, Injectable, type ExecutionHistoryRecord } from "@agboss/core";
import type { ExecutionHistoryQuery, Page, TenantExecutionHistoryQuery } from "@agboss/core/stores";
import type { Collection, Filter } from "mongodb";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import { historyRecordOf } from "./history/history-documents.js";
import { idOf } from "./keys.js";
import { listingWindowOf, pageOfWindow, type ListingWindow } from "./listing-window.js";

/** One kept root execution: its record as JSON text beside the fields it is found by. */
export interface HistoryDocument {
  _id: string;
  tenantId: string;
  executionId: string;
  threadId: string;
  startedAt: Date | null;
  endedAt: Date | null;
  record: string;
}

/** A time of the record (ISO 8601, the framework's `Clock`) as a date. */
const momentOf = (iso: string | undefined): Date | null =>
  iso === undefined ? null : new Date(iso);

/**
 * `ExecutionHistoryRepository` on MongoDB (agbossjs/agboss#483, #527): one document per kept root
 * execution, `_id` its tenant and execution, its record as JSON text beside the fields it is found
 * by. `save` is one replace with upsert (the same root saved twice keeps the last), so the instances
 * share one history. Reads are one `find` each, oldest start first, ids ordered byte-wise (the
 * simple collation); the periods' reads paged by `skip` / `limit`. The sweep removes only ended
 * documents, by the `Clock`'s cutoff.
 */
@Injectable({ deps: [MongoConnection] })
export class MongoExecutionHistoryRepository extends ExecutionHistoryRepository {
  constructor(private readonly connection: MongoConnection) {
    super();
  }

  get #history(): Collection<HistoryDocument> {
    return this.connection.db.collection<HistoryDocument>(Collections.ExecutionHistory);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async save(record: ExecutionHistoryRecord): Promise<void> {
    const _id = idOf(record.tenantId, record.executionId);
    await this.#history.replaceOne(
      { _id },
      {
        tenantId: record.tenantId,
        executionId: record.executionId,
        threadId: record.threadId,
        startedAt: momentOf(record.startedAt),
        endedAt: momentOf(record.endedAt),
        record: JSON.stringify(record),
      },
      { upsert: true },
    );
  }

  async findByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
  ): Promise<ExecutionHistoryRecord | undefined> {
    const [found] = await this.#where({ _id: idOf(tenantId, executionId) });
    return found;
  }

  findAllByExecutionId(executionId: string): Promise<ExecutionHistoryRecord[]> {
    return this.#where({ executionId });
  }

  findAllByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
  ): Promise<ExecutionHistoryRecord[]> {
    return this.#where({ tenantId, threadId });
  }

  async findAllByTenantIdAndStartedAtBetween(
    query: TenantExecutionHistoryQuery,
  ): Promise<Page<ExecutionHistoryRecord>> {
    const window = listingWindowOf(query);
    const found = await this.#where(
      { tenantId: query.tenantId, startedAt: { $gte: query.from, $lt: query.to } },
      window,
    );
    return pageOfWindow(found, window);
  }

  async findAllByStartedAtBetween(
    query: ExecutionHistoryQuery,
  ): Promise<Page<ExecutionHistoryRecord>> {
    const window = listingWindowOf(query);
    const found = await this.#where({ startedAt: { $gte: query.from, $lt: query.to } }, window);
    return pageOfWindow(found, window);
  }

  /** Removes the ended records that ended before `cutoff`; how many went. */
  async deleteExpired(cutoff: Date): Promise<number> {
    const removed = await this.#history.deleteMany({ endedAt: { $ne: null, $lt: cutoff } });
    return removed.deletedCount;
  }

  /** The records whose document matches `filter`, oldest start first; a page of them when given. */
  async #where(
    filter: Filter<HistoryDocument>,
    page?: ListingWindow,
  ): Promise<ExecutionHistoryRecord[]> {
    const cursor = this.#history.find(filter).sort({ startedAt: 1, executionId: 1 });
    // one more than the page, to know whether another follows (a window's limit is from 1)
    const paged = page === undefined ? cursor : cursor.skip(page.offset).limit(page.limit + 1);
    return (await paged.toArray()).map(historyRecordOf);
  }
}
