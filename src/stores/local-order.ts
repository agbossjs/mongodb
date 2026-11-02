/**
 * The order of one instance's fenced calls (agbossjs/agboss#527). A MongoDB transaction takes no
 * lock it waits on: of two transactions writing one document, the one that writes it second
 * conflicts and is run again by the driver — so of two calls an instance makes at once on one lease
 * or one business key, the one whose command reached the server first wins, whichever was called
 * first. PostgreSQL's row locks queue them in the order they were sent. Here the calls of one
 * instance on one key run one after another, in the order they were made: the first called is the
 * first to commit, as on PostgreSQL, and the instance's own calls never fight each other with
 * write conflicts. Across instances the transactions decide, as before.
 *
 * A call waits for every call before it on any of its keys, then runs; a chain of promises per key,
 * so calls on overlapping keys never wait in a cycle (each waits only for calls made before it).
 */

/** The tail of each key's queue, per owner (one store instance). */
const queues = new WeakMap<object, Map<string, Promise<unknown>>>();

/** `call` once every call `owner` made before it on any of `keys` has settled. */
export function inLocalOrder<TValue>(
  owner: object,
  keys: readonly string[],
  call: () => Promise<TValue>,
): Promise<TValue> {
  const tails = queues.get(owner) ?? new Map<string, Promise<unknown>>();
  queues.set(owner, tails);
  const before = keys.flatMap((key) => {
    const tail = tails.get(key);
    return tail === undefined ? [] : [tail];
  });
  const result = Promise.allSettled(before).then(call);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  for (const key of keys) tails.set(key, settled);
  void settled.then(() => {
    for (const key of keys) if (tails.get(key) === settled) tails.delete(key);
  });
  return result;
}

/** The keys a fenced call on `key` is ordered by: its lease, and its business identity when it has one. */
export const fencedOrderKeysOf = (
  key: {
    readonly tenantId: string;
    readonly leaseExecutionId: string;
    readonly businessKey?: string;
  },
  identity: string,
): readonly string[] =>
  key.businessKey === undefined
    ? [JSON.stringify(["lease", key.tenantId, key.leaseExecutionId])]
    : [
        JSON.stringify(["lease", key.tenantId, key.leaseExecutionId]),
        JSON.stringify(["key", identity]),
      ];
