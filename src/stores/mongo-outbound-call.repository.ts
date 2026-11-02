import {
  checkedBusinessKey,
  checkedEffectName,
  Injectable,
  OutboundCallRepository,
  OutboundCallStatus,
  pendingOutboundCallOf,
  StoreClock,
  type Class,
  type FencedEffectKey,
  type OutboundCallClaim,
  type OutboundCallFailure,
  type OutboundCallIntent,
  type OutboundCallLease,
  type OutboundCallLeaseState,
  type OutboundCallRecord,
  type OutboundCallState,
} from "@agboss/core";
import type { Collection, Filter } from "mongodb";
import { Collections } from "../connection/collections.js";
import { MongoConnection } from "../connection/mongodb-connection.js";
import type { MongoTransaction } from "../connection/transaction.js";
import { checkFence } from "./fence.js";
import { MongoExecutionLeaseRepository } from "./mongo-execution-lease.repository.js";
import { fencedOrderKeysOf, inLocalOrder } from "./local-order.js";
import { leaseStateIn } from "./outbound-calls/lease-state.js";
import {
  callIdOf,
  callRecordOf,
  ENDING_FIELDS,
  type OutboundCallDocument,
} from "./outbound-calls/outbound-call-documents.js";
import { nextSequence } from "./sequence.js";

/** The state the document must still be in: its status and attempt owner, its attempt when given. */
interface AsRead {
  readonly status: OutboundCallStatus;
  readonly attempt?: number;
  readonly attemptOwner: string;
}

/** The change of a compare-and-set: the record's new fields, and its new end. */
interface Change {
  readonly fields: Partial<OutboundCallRecord>;
  readonly endedAt?: Date;
}

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
  static override readonly backend: string | undefined = "mongodb";
  static override readonly leaseRepository: Class | undefined = MongoExecutionLeaseRepository;

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

  findByKey(key: FencedEffectKey): Promise<OutboundCallRecord | undefined> {
    return this.#fenced(key, async ({ session }) => {
      const found = await this.#calls.findOne({ _id: callIdOf(key) }, { session });
      return found === null ? undefined : callRecordOf(found);
    });
  }

  async saveIfAbsent(key: FencedEffectKey, intent: OutboundCallIntent): Promise<boolean> {
    checkedEffectName(key.name);
    checkedBusinessKey(key);
    const seq = await nextSequence(this.connection.db, Collections.OutboundCalls);
    return this.#fenced(key, async ({ session }) => {
      const record = pendingOutboundCallOf(key, intent, this.clock.now());
      const document: OutboundCallDocument = {
        _id: callIdOf(key),
        ...{ seq, record, tenantId: key.tenantId, rootExecutionId: intent.rootExecutionId },
        ...{ status: record.status, attempt: record.attempt, attemptOwner: record.attemptOwner },
        endedAt: null,
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
    key: FencedEffectKey,
    expected: OutboundCallState,
    claim: OutboundCallClaim,
  ): Promise<boolean> {
    return this.#moved(key, expected, {
      fields: { status: OutboundCallStatus.Pending, ...claim },
    });
  }

  markCompleted(key: FencedEffectKey, attemptOwner: string, result: string): Promise<boolean> {
    const endedAt = this.clock.now();
    const status = OutboundCallStatus.Completed;
    return this.#moved(
      key,
      { status: OutboundCallStatus.Pending, attemptOwner },
      { fields: { status, result, endedAt: endedAt.toISOString() }, endedAt },
    );
  }

  markFailed(
    key: FencedEffectKey,
    attemptOwner: string,
    failure: OutboundCallFailure,
  ): Promise<boolean> {
    const endedAt = this.clock.now();
    const { name, code, message } = failure;
    const fields = {
      status: OutboundCallStatus.Failed,
      failure: { name, code, message },
      endedAt: endedAt.toISOString(),
    };
    return this.#moved(
      key,
      { status: OutboundCallStatus.Pending, attemptOwner },
      { fields, endedAt },
    );
  }

  findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly OutboundCallRecord[]> {
    return this.#where({ tenantId, rootExecutionId });
  }

  findAllByTenantIdAndStatus(
    tenantId: string,
    status: OutboundCallStatus,
  ): Promise<readonly OutboundCallRecord[]> {
    return this.#where({ tenantId, status });
  }

  async deleteByEndedAtBefore(cutoff: Date): Promise<void> {
    // a pending intent has no end (`null`), which `$lt` never matches: it is never removed
    await this.#calls.deleteMany({ endedAt: { $ne: null, $lt: cutoff } });
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
   * The compare-and-set of `key`'s document, fenced: `change` written under the key's lease and
   * token only while it is still `from` — one `updateOne`, `true` when it matched.
   */
  #moved(key: FencedEffectKey, from: AsRead, change: Change): Promise<boolean> {
    return this.#fenced(key, async ({ session }) => {
      const fields = { ...change.fields, token: key.token, leaseExecutionId: key.leaseExecutionId };
      const set = Object.fromEntries(
        Object.entries(fields).map(([field, value]) => [`record.${field}`, value]),
      );
      const unset = ENDING_FIELDS.filter((field) => !(field in set));
      const moved = await this.#calls.updateOne(
        {
          _id: callIdOf(key),
          status: from.status,
          attemptOwner: from.attemptOwner,
          ...(from.attempt === undefined ? {} : { attempt: from.attempt }),
        },
        {
          $set: {
            ...set,
            status: fields.status ?? from.status,
            ...(fields.attempt === undefined ? {} : { attempt: fields.attempt }),
            ...(fields.attemptOwner === undefined ? {} : { attemptOwner: fields.attemptOwner }),
            endedAt: change.endedAt ?? null,
          },
          ...(unset.length === 0
            ? {}
            : { $unset: Object.fromEntries(unset.map((field) => [field, ""])) }),
        },
        { session },
      );
      return moved.matchedCount === 1;
    });
  }

  /** `work` after the fencing checks (the lease locked, the mark raised), in one transaction. */
  async #fenced<TValue>(
    key: FencedEffectKey,
    work: (transaction: MongoTransaction) => Promise<TValue>,
  ): Promise<TValue> {
    checkedEffectName(key.name);
    // a business key's text (agbossjs/agboss#538): refused by its rule before any command
    checkedBusinessKey(key);
    // this instance's calls on one lease or business key commit in the order they were made
    return inLocalOrder(this, fencedOrderKeysOf(key, callIdOf(key)), () =>
      this.connection.inTransaction(async (transaction) => {
        await checkFence(transaction.db, transaction.session, key, this.clock);
        return work(transaction);
      }),
    );
  }
}
