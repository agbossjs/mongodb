import type { Clock } from "@agboss/core";
import { seconds } from "@agboss/core/units";

/**
 * How long an orderly close may take at an instance's stop before it is given up
 * (agbossjs/agboss#923): a server that went quiet never lets the driver finish it, and the stop
 * must end.
 */
export const CLOSE_GRACE = seconds(1);

/**
 * `close()`, or — when it has not ended within `CLOSE_GRACE` on `clock` — nothing: the close is
 * left to finish by itself (the driver closes the connections in use first, then waits for the
 * server's cleanup), and its late failure is dropped, so nothing rejects unhandled. The driver
 * cannot destroy the sockets of a client that is closing (`MongoClient.close()` takes no `force`
 * since 6.0). Without a `clock` (a connection built by a script) the close is the orderly one only.
 */
export async function closeBounded(
  close: () => Promise<unknown>,
  clock: Clock | undefined,
): Promise<void> {
  const orderly = close().then(
    () => undefined,
    () => undefined,
  );
  if (clock === undefined) {
    await orderly;
    return;
  }
  const waiting = new AbortController();
  try {
    await Promise.race([orderly, clock.sleep(CLOSE_GRACE, waiting.signal).catch(() => undefined)]);
  } finally {
    waiting.abort();
  }
}
