import { Injectable, StoreClock } from "@agboss/core";
import {
  OutboundCallRepository,
  pendingOutboundCallOf,
  type EffectKey,
  type OutboundCallClaim,
  type OutboundCallFailure,
  type OutboundCallIntent,
  type OutboundCallLease,
  type OutboundCallLeaseState,
  type OutboundCallRecord,
  type OutboundCallState,
  type OutboundCallStatusQuery,
  type Page,
  type StoreDescriptor,
} from "@agboss/core/stores";
import { OutboundCallStatus } from "@agboss/core";
import type { Collection, Filter } from "mongodb";
import { z } from "zod";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import type { MongoTransaction } from "../connection/transaction.js";
import { checkCancel } from "./cancel-fence.js";
import { checkFence } from "./fence.js";
import { fencedOrderKeysOf, inLocalOrder } from "./local-order.js";
import { foundOf } from "./outbound-calls/outbound-call-lookup.js";
import { leaseStateIn } from "./outbound-calls/lease-state.js";
import {
  callIdOf,
  callRecordOf,
  moveOf,
  type AsRead,
  type Change,
  type ChangeAt,
  type OutboundCallDocument,
} from "./outbound-calls/outbound-call-documents.js";
import { nextSequence } from "./sequence.js";
import { pageLimitOf, seqOfCursor } from "./outbound-call-pages.js";
import { assertKeyAtEntry } from "./key-entry.js";

/** A page's last document's place in the record order (agbossjs/agboss#825), checked: documents are never trusted. */
const SeqOf = z.object({ seq: z.number().int().positive() });

/**
 * `OutboundCallRepository` on MongoDB (agbossjs/agboss#505, #508, #527): one document per intent in
 * `agboss_outbound_calls`, beside the leases and the scopes' marks of the fenced effects. Every
 * fenced method is one transaction (`MongoConnection.inTransaction`): the key's name and business
 * key checked, the lease locked by a write and checked, the scope's mark raised (`checkFence`),
 * then one command. `saveIfAbsent` is an upsert with `$setOnInsert` on the key's `_id` — of two
 * savers exactly one inserts (the other conflicts, is run again and finds it); every move is one
 * `updateOne` whose filter is the status, attempt and attempt owner the caller read — a
 * compare-and-set, also for one business key moved under two leases that no lease lock
 * serializes: the second writer of the document conflicts and is run again on the first's result.
 * `leaseStateOf` locks the lease and closes an expired one in the same transaction. The order
 * recorded is a sequence drawn before the transaction. Listed with `MongoExecutionLeaseRepository`.
 */
@Injectable({ deps: [MongoConnection, StoreClock] })
export class MongoOutboundCallRepository extends OutboundCallRepository {
  /** One transactional backend with the other MongoDB stores (agbossjs/agboss#526). */
  static override readonly store: StoreDescriptor = { backend: "mongodb" };

  constructor(
    private readonly connection: MongoConnection,
    private readonly clock: StoreClock,
  ) {
    super();
  }

  get #calls(): Collection<OutboundCallDocument> {
    return this.connection.db.collection<OutboundCallDocument>(Collections.OutboundCalls);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  findByKey(key: EffectKey): Promise<OutboundCallRecord | undefined> {
    return this.#fenced(key, false, async ({ session }, now) => {
      const found = await foundOf(this.#calls, key, session);
      // read at the store's time the fence decided by (agbossjs/agboss#658), never stored
      return found === null ? undefined : { ...callRecordOf(found), readAt: now.toISOString() };
    });
  }

  async saveIfAbsent(key: EffectKey, intent: OutboundCallIntent): Promise<boolean> {
    // the key's name, business key and fingerprint decision (agbossjs/agboss#508, #538, #825)
    assertKeyAtEntry(key);
    const seq = await nextSequence(this.connection.db, Collections.OutboundCalls);
    // a new intent is a new send (agbossjs/agboss#909): refused after the tree's cancel
    return this.#fenced(key, true, async ({ session }, now) => {
      // its first attempt starts at the store's time (agbossjs/agboss#658: the server's own)
      const startedAt = now.toISOString();
      const record = {
        ...pendingOutboundCallOf(key, intent, this.clock.now()),
        attemptStartedAt: startedAt,
        firstAttemptStartedAt: startedAt,
      };
      const document: OutboundCallDocument = {
        _id: callIdOf(key),
        ...{ seq, record, tenantId: key.tenantId, rootExecutionId: intent.rootExecutionId },
        ...{ status: record.status, attempt: record.attempt, attemptOwner: record.attemptOwner },
        expiresAt: null,
      };
      const saved = await this.#calls.updateOne(
        { _id: document._id },
        { $setOnInsert: document },
        { upsert: true, session },
      );
      return saved.upsertedCount === 1;
    });
  }

  markPending(
    key: EffectKey,
    expected: OutboundCallState,
    claim: OutboundCallClaim,
  ): Promise<boolean> {
    // the next attempt starts at the store's time (agbossjs/agboss#658); the first's start is kept
    const status = OutboundCallStatus.Pending;
    const claimed = (now: Date): Change => ({
      fields: { status, ...claim, attemptStartedAt: now.toISOString() },
    });
    return this.#moved(key, expected, claimed, true);
  }

  markCompleted(
    key: EffectKey,
    attemptOwner: string,
    result: string,
    expiresAt: Date | null,
  ): Promise<boolean> {
    const endedAt = this.clock.now().toISOString();
    const status = OutboundCallStatus.Completed;
    return this.#moved(key, { status: OutboundCallStatus.Pending, attemptOwner }, () => ({
      fields: { status, result, endedAt },
      expiresAt,
    }));
  }

  markFailed(
    key: EffectKey,
    attemptOwner: string,
    failure: OutboundCallFailure,
    expiresAt: Date | null,
  ): Promise<boolean> {
    const endedAt = this.clock.now().toISOString();
    const { name, code, message } = failure;
    const fields = {
      status: OutboundCallStatus.Failed,
      failure: { name, code, message },
      endedAt,
    };
    return this.#moved(key, { status: OutboundCallStatus.Pending, attemptOwner }, () => ({
      fields,
      expiresAt,
    }));
  }

  findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly OutboundCallRecord[]> {
    return this.#where({ tenantId, rootExecutionId });
  }

  /**
   * A page of a tenant's calls in `status` (agbossjs/agboss#825): keyset on `seq` — drawn once per intent from the
   * sequence, never reused, never changed by a move — on the index `by_status`; the cursor is the
   * page's last `seq`, as text.
   */
  async findAllByTenantIdAndStatus(
    query: OutboundCallStatusQuery,
  ): Promise<Page<OutboundCallRecord>> {
    const { tenantId, status, cursor } = query;
    const limit = pageLimitOf(query.limit);
    const from = cursor === undefined ? 0 : seqOfCursor(cursor);
    const found = await this.#calls
      .find({ tenantId, status, seq: { $gt: from } })
      .sort({ seq: 1 })
      .limit(limit + 1)
      .toArray();
    const page = found.slice(0, limit);
    const items = page.map(callRecordOf);
    // more than a page was found: the page is not empty (a limit is from 1), its last `seq` the cursor
    return found.length <= limit
      ? { items }
      : { items, nextCursor: String(SeqOf.parse(page.at(-1)).seq) };
  }

  /**
   * Removes the ended calls whose `expiresAt` has come (`<= now`): a call with none (`Ttl.Forever`,
   * or still pending: `null`, which `$lte` never matches) is never removed. How many went.
   */
  async deleteExpired(now: Date): Promise<number> {
    const removed = await this.#calls.deleteMany({ expiresAt: { $type: "date", $lte: now } });
    return removed.deletedCount;
  }

  leaseStateOf(lease: OutboundCallLease): Promise<OutboundCallLeaseState> {
    return this.connection.inTransaction(({ db, session }) =>
      leaseStateIn(db, session, lease, this.clock),
    );
  }

  async #where(filter: Filter<OutboundCallDocument>): Promise<readonly OutboundCallRecord[]> {
    const found = await this.#calls.find(filter).sort({ seq: 1 }).toArray();
    return found.map(callRecordOf);
  }

  /**
   * The compare-and-set of `key`'s document, fenced: `changeAt(now)` — `now` the store's time the
   * fence decided by — written under the key's lease and token only while it is still `from`; one
   * `updateOne`, `true` when it matched.
   */
  #moved(key: EffectKey, from: AsRead, changeAt: ChangeAt, isSend = false): Promise<boolean> {
    return this.#fenced(key, isSend, async ({ session }, now) => {
      const { filter, update } = moveOf(key, from, changeAt(now));
      const moved = await this.#calls.updateOne(filter, update, { session });
      return moved.matchedCount === 1;
    });
  }

  /**
   * `work` after the fencing checks (the lease locked, the mark raised) and, for a method that
   * starts a send (`isSend`), the tree's cancel (agbossjs/agboss#909), in one transaction.
   */
  async #fenced<TValue>(
    key: EffectKey,
    isSend: boolean,
    work: (transaction: MongoTransaction, now: Date) => Promise<TValue>,
  ): Promise<TValue> {
    // the key's name, business key and fingerprint decision (agbossjs/agboss#508, #538, #825)
    assertKeyAtEntry(key);
    // this instance's calls on one lease or business key commit in the order they were made
    return inLocalOrder(this, fencedOrderKeysOf(key, callIdOf(key)), () =>
      this.connection.inTransaction(async (transaction) => {
        const { db, session } = transaction;
        const now = await checkFence(db, session, key, this.clock);
        if (isSend) await checkCancel(db, session, key);
        return work(transaction, now);
      }),
    );
  }
}
