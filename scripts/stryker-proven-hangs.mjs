// The Timeouts of the mutation shards that are real hangs (see stryker-timeouts.mjs): per shard, each
// told by `file`, `mutator`, `replacement`, `anchor` (the line's text, trimmed) and `kind`, with the `reason`.
// `kind: "any"`: a loop that awaits ends by whichever comes first, the hit limit, the time limit or a test's own
// timeout (which kills it): the entry matches a Timeout of either kind and is never stale.
import { PAUSES_HANGS } from "./stryker-pauses-hangs.mjs";

export const PROVEN_HANGS = {
  // the wait for live leases polls a counted number of times; a loop whose body is emptied never ends, and counts no
  // iteration for a test to fail by: Stryker's hit counter ends it
  pauses: PAUSES_HANGS,
  // the watch's reopen retries with growing pauses until a start succeeds or the watch is stopped
  "queue-watch": [
    {
      file: "stores/queue-watch.ts",
      mutator: "BlockStatement",
      replacement: "{}",
      anchor: "for (let attempt = 0; ; attempt += 1) {",
      kind: "hit-limit",
      reason:
        "the reopen loop's body is emptied: `for (;;) {}` never pauses, never starts and never ends",
    },
    {
      file: "stores/queue-watch.ts",
      mutator: "ConditionalExpression",
      replacement: "false",
      anchor: "if (signal.aborted) return;",
      kind: "hit-limit",
      reason:
        "the reopen loop no longer ends when the watch is stopped: a stopped watch whose start fails goes round for ever, on a clock that never yields a macrotask to a test",
    },
  ],
  // the liveness watch pings every half of the bound until it is stopped or the connection is declared dead
  "store-bound": [
    {
      file: "connection/heartbeat.ts",
      mutator: "BlockStatement",
      replacement: "{}",
      anchor: "for (;;) {",
      kind: "hit-limit",
      reason:
        "the watch's loop has an empty body: `for (;;) {}` never sleeps, never pings and never ends",
    },
  ],
  migrations: [
    {
      file: "connection/live-leases.ts",
      mutator: "BlockStatement",
      replacement: "{}",
      anchor: "for (let attempt = 1; ; attempt += 1) {",
      kind: "hit-limit",
      reason:
        "the loop's body is emptied: `for (;;) {}` never sleeps, never counts an attempt and never ends",
    },
  ],
  // `saveIfAbsent` retries a duplicate key up to `SAVE_ATTEMPTS` times (a commit landed in between); a mutant of the
  // loop that never ends is ended by Stryker's hit counter, which no test can beat: the loop awaits, so a test's
  // own timeout would fire only after it
  "a2a-direct": [
    ...[
      [
        "AssignmentOperator",
        "attempt -= 1",
        "for (let attempt = 1; ; attempt += 1) {",
        "the attempt counts down, so `attempt >= SAVE_ATTEMPTS` is never true: a save that meets a duplicate key every time retries for ever",
      ],
      [
        "BlockStatement",
        "{}",
        "for (let attempt = 1; ; attempt += 1) {",
        "the loop's body is emptied: `for (;;) {}` never ends",
      ],
      [
        "BlockStatement",
        "{}",
        "try {",
        "the try block is emptied, so nothing returns and the loop never ends",
      ],
      [
        "BlockStatement",
        "{}",
        "} catch (error) {",
        "the catch block is emptied: every error is swallowed and the save retried for ever",
      ],
      [
        "ConditionalExpression",
        "false",
        "if (!hasCode(error, DUPLICATE_KEY) || attempt >= SAVE_ATTEMPTS) throw error;",
        "the condition, or its bound, is false: the error is never thrown and the retry never ends",
      ],
      [
        "LogicalOperator",
        "!hasCode(error, DUPLICATE_KEY) && attempt >= SAVE_ATTEMPTS",
        "if (!hasCode(error, DUPLICATE_KEY) || attempt >= SAVE_ATTEMPTS) throw error;",
        "an error is thrown only when it is no duplicate key and past the bound: a duplicate key is retried for ever",
      ],
    ].map(([mutator, replacement, anchor, reason]) => ({
      file: "stores/mongo-a2a-direct-message.repository.ts",
      mutator,
      replacement,
      anchor,
      kind: "hit-limit",
      reason,
    })),
  ],
};
