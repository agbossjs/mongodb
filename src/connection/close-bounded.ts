import type { Clock } from "@agboss/core";
import { seconds, type Milliseconds } from "@agboss/core/units";
import { createRequire } from "node:module";
import type { MongoClient } from "mongodb";
import { MongoDriverInternalsError } from "../errors.js";

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
export async function closeBoundedEnded(
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
 * about its sessions. The driver's `topology` is internal, found by name: `assertDriverInternals`
 * checks it once when the connection starts, so a driver that changed it fails there, loudly,
 * never here as a stop that silently leaves the sockets open.
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

/** An object's own-or-inherited property, `undefined` when `value` is not an object. */
function member(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/** The installed `mongodb` driver's version (its own package.json), `unknown` when it cannot be read. */
function driverVersion(): string {
  try {
    const version = member(createRequire(import.meta.url)("mongodb/package.json"), "version");
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The first internal the bounded stop reaches that `client` (connected) does not have in the
 * expected shape: `client.topology` an object with a `close` function and `s.servers` a `Map`, each
 * server's `pool.checkedOut` a `Set`; `undefined` when all are there.
 */
export function missingDriverInternal(client: MongoClient): string | undefined {
  const topology = member(client, "topology");
  if (typeof topology !== "object" || topology === null) return "client.topology (an object)";
  if (typeof member(topology, "close") !== "function") return "client.topology.close (a function)";
  const servers = member(member(topology, "s"), "servers");
  if (!(servers instanceof Map)) return "client.topology.s.servers (a Map)";
  for (const server of servers.values())
    if (!(member(member(server, "pool"), "checkedOut") instanceof Set))
      return "client.topology.s.servers[].pool.checkedOut (a Set)";
  return undefined;
}

/**
 * Fails with `MongoDriverInternalsError` when the driver's internals the bounded stop reaches are
 * not what it expects (agbossjs/agboss#1236): called with the connected client when the connection
 * starts, so a driver release that renamed them is a start that fails, not a stop that quietly
 * leaves the sockets to a server that went quiet open.
 */
export function assertDriverInternals(client: MongoClient): void {
  const missing = missingDriverInternal(client);
  if (missing !== undefined)
    throw new MongoDriverInternalsError({ driverVersion: driverVersion(), missing });
}

/** Whether any pool of `client` has a connection checked out: a call waits for its answer. */
function hasCallsInFlight(client: MongoClient): boolean {
  const servers = member(member(member(client, "topology"), "s"), "servers");
  if (!(servers instanceof Map)) return false; // checked at the start by `assertDriverInternals`
  return [...servers.values()].some((server: unknown) => {
    const checkedOut = member(member(server, "pool"), "checkedOut");
    return checkedOut instanceof Set && checkedOut.size > 0;
  });
}

/**
 * The sockets of `client`, whose close is waiting on a server that does not answer, destroyed at
 * once: the driver's topology (pools, monitors) closed beside the waiting close, which then ends by
 * itself.
 */
function dropSockets(client: MongoClient): void {
  client.close().catch(() => undefined); // the late failure of a close left running is dropped
  const topology = member(client, "topology");
  const close = member(topology, "close");
  if (typeof close !== "function") return; // checked at the start by `assertDriverInternals`
  try {
    Reflect.apply(close, topology, []);
  } catch {
    // the driver's own close finishes what it can
  }
}
