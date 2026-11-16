import type { Clock } from "@agboss/core";
import { seconds, type Milliseconds } from "@agboss/core/units";
import type { MongoClient } from "mongodb";

/**
 * How long an orderly close may take at an instance's stop before it is given up
 * (agbossjs/agboss#923): a server that went quiet never lets the driver finish it, and the stop
 * must end.
 */
export const CLOSE_GRACE = seconds(1);

/**
 * `close()`, or — when it has not ended within `grace` (`CLOSE_GRACE`) on `clock` — nothing: the close is
 * left to finish by itself (the driver closes the connections in use first, then waits for the
 * server's cleanup), and its late failure is dropped, so nothing rejects unhandled. A client's own sockets are destroyed by `closeClientBounded`. Without a `clock` (a connection built by a script) the close is the orderly one only.
 */
export async function closeBounded(
  close: () => Promise<unknown>,
  clock: Clock | undefined,
  grace: Milliseconds = CLOSE_GRACE,
): Promise<void> {
  await closeBoundedEnded(close, clock, grace);
}

/** `closeBounded`, and whether the close ended within the grace (`false`: it is left running). */
async function closeBoundedEnded(
  close: () => Promise<unknown>,
  clock: Clock | undefined,
  grace: Milliseconds,
): Promise<boolean> {
  let ended = false;
  const orderly = close().then(
    () => undefined,
    () => undefined,
  );
  const done = orderly.then(() => {
    ended = true;
  });
  if (clock === undefined) {
    await done;
    return true;
  }
  const waiting = new AbortController();
  try {
    await Promise.race([done, clock.sleep(grace, waiting.signal).catch(() => undefined)]);
  } finally {
    waiting.abort();
  }
  return ended;
}

/**
 * `client.close()` bounded as `closeBounded` is, and the client's sockets destroyed
 * (agbossjs/agboss#954): the driver's close waits for the server to end its sessions and kill its
 * cursors, and only then closes its topology (the pools' idle connections, the monitors'); a server
 * that does not answer holds it, and `MongoClient.close()` takes no `force` since 6.0. The topology —
 * still held by the client while the close waits — is closed beside it, so the close ends by itself.
 * When calls are in flight (a server that does not answer holds them, and the stop has used its
 * time on them: a hook is given one turn of the loop once the stop's end has passed) the sockets go
 * at once; else after `grace` — an orderly close on a healthy server ends sooner and tells it
 * about its sessions. The driver's `topology` is internal: found by name, a driver that changed it
 * leaves the close to itself.
 */
export async function closeClientBounded(
  client: MongoClient,
  clock: Clock | undefined,
  grace: Milliseconds = CLOSE_GRACE,
): Promise<void> {
  const closing = closeBoundedEnded(() => client.close(), clock, grace);
  if (hasCallsInFlight(client)) dropSockets(client);
  if (!(await closing)) dropSockets(client);
}

/** Whether any pool of `client` has a connection checked out: a call waits for its answer. */
function hasCallsInFlight(client: MongoClient): boolean {
  try {
    const topology: unknown = Reflect.get(client, "topology");
    const state: unknown =
      typeof topology === "object" && topology !== null ? Reflect.get(topology, "s") : undefined;
    const servers: unknown =
      typeof state === "object" && state !== null ? Reflect.get(state, "servers") : undefined;
    if (!(servers instanceof Map)) return false;
    return [...servers.values()].some((server: unknown) => {
      const pool: unknown =
        typeof server === "object" && server !== null ? Reflect.get(server, "pool") : undefined;
      const checkedOut: unknown =
        typeof pool === "object" && pool !== null ? Reflect.get(pool, "checkedOut") : undefined;
      return checkedOut instanceof Set && checkedOut.size > 0;
    });
  } catch {
    return false;
  }
}

/**
 * The sockets of `client`, whose close is waiting on a server that does not answer, destroyed at
 * once: the driver's topology (pools, monitors) closed beside the waiting close, which then ends by
 * itself.
 */
function dropSockets(client: MongoClient): void {
  client.close().catch(() => undefined); // the late failure of a close left running is dropped
  try {
    // the driver's own, internal: found by name, a driver that changed it leaves the close to itself
    const topology: unknown = Reflect.get(client, "topology");
    const close: unknown =
      typeof topology === "object" && topology !== null
        ? Reflect.get(topology, "close")
        : undefined;
    if (typeof close === "function") Reflect.apply(close, topology, []);
  } catch {
    // the driver's own close finishes what it can
  }
}
