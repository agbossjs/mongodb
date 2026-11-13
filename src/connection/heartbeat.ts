import type { Clock } from "@agboss/core";
import { seconds } from "@agboss/core/units";

/** What `watchLiveness` needs of a connection. */
export interface LivenessOptions {
  readonly clock: Clock;
  /** The longest a dead connection goes unnoticed, in seconds: a ping every half, an answer due in the other. */
  readonly livenessSeconds: number;
  /** One cheap command over the connection; it rejects when the connection fails. */
  readonly ping: () => Promise<unknown>;
  /** Ends the watch (the connection is closed or replaced). */
  readonly signal: AbortSignal;
}

/**
 * Pings a connection every half of `liveness` until `signal` aborts (agbossjs/agboss#789): a
 * half-open TCP connection (a NAT or a load balancer that dropped its state) answers nothing and
 * fails nothing, so only a command that is not answered shows it. Every timer is on the `Clock`.
 * Resolves with why the connection is dead — the ping failed, or was not answered within the other
 * half of `livenessSeconds` — or with `undefined` when `signal` aborted first.
 */
export async function watchLiveness(options: LivenessOptions): Promise<string | undefined> {
  const { clock, livenessSeconds, ping, signal } = options;
  const half = seconds(livenessSeconds / 2);
  const isEnded = (): boolean => signal.aborted;
  for (;;) {
    await clock.sleep(half, signal);
    if (isEnded()) return undefined;
    const answered = new AbortController();
    const outcome = await Promise.race([
      ping().then(
        () => "answered",
        (error: unknown) => `the ping failed: ${error instanceof Error ? error.message : "error"}`,
      ),
      clock
        .sleep(half, AbortSignal.any([signal, answered.signal]))
        .then(() => `no answer to a ping in ${String(livenessSeconds / 2)} s`),
    ]);
    answered.abort();
    if (isEnded()) return undefined;
    if (outcome !== "answered") return outcome;
  }
}
