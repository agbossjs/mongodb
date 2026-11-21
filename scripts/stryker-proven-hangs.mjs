// The Timeouts of the mutation shards that are real hangs (see stryker-timeouts.mjs): per shard, each
// told by `file`, `mutator`, `replacement`, `anchor` (the line's text, trimmed) and `kind`, with the `reason`.
export const PROVEN_HANGS = {
  // the wait for live leases polls a counted number of times; a loop whose body is emptied never ends, and counts no
  // iteration for a test to fail by: Stryker's hit counter ends it
  // the retention sweep and the scans of the pause store page until a page is empty; a mutant that keeps a page
  // from ending it is a loop no test can fail by, and Stryker's hit counter ends it
  pauses: [
    ...[
      [
        "stores/mongo-paused-execution.repository.ts",
        "BlockStatement",
        "{}",
        "for (;;) {",
        "the sweep's loop has an empty body: `for (;;) {}` never ends",
      ],
      [
        "stores/mongo-paused-execution.repository.ts",
        "ArrayDeclaration",
        '["Stryker was here"]',
        "if (batch.length === 0) return [];",
        "an empty batch answers one id, which removes nothing and is added to the removed set: the sweep asks for an empty batch for ever",
      ],
      [
        "stores/paused/pause-delivery.ts",
        "BlockStatement",
        "{}",
        "while (claims.length < limit) {",
        "the claim loop's body is emptied: no claim is ever added, so `claims.length < limit` stays true for ever",
      ],
      [
        "stores/paused/pause-delivery.ts",
        "BlockStatement",
        "{}",
        "while (taken.length < limit) {",
        "the take loop's body is emptied: nothing is ever taken, so `taken.length < limit` stays true for ever",
      ],
      [
        "stores/paused/pause-scans.ts",
        "ObjectLiteral",
        "{}",
        "return {",
        "the keyset's filter is emptied: every page starts at the first and the scan never reaches its end",
      ],
      [
        "stores/paused/pause-scans.ts",
        "ObjectLiteral",
        "{}",
        "{ [field]: { $gt: time } },",
        "a branch of the keyset is emptied, so it matches every pause: the page after a cursor is the first again, for ever",
      ],
      [
        "stores/paused/pause-scans.ts",
        "ObjectLiteral",
        "{}",
        "{ [field]: time, tenantId: { $gt: tenantId } },",
        "a branch of the keyset is emptied, so it matches every pause: the page after a cursor is the first again, for ever",
      ],
      [
        "stores/paused/pause-scans.ts",
        "ObjectLiteral",
        "{}",
        "{ [field]: time, tenantId, pauseId: { $gt: pauseId } },",
        "a branch of the keyset is emptied, so it matches every pause: the page after a cursor is the first again, for ever",
      ],
      [
        "stores/paused/pause-scans.ts",
        "BlockStatement",
        "{}",
        "while (removable.length < limit) {",
        "the scan's loop has an empty body: nothing is ever added, so `removable.length < limit` stays true for ever",
      ],
      [
        "stores/mongo-paused-execution.repository.ts",
        "ArrowFunction",
        "() => undefined",
        "const ids = batch.map((one) => one._id);",
        "the ids of the batch are all `undefined`: the delete removes nothing, the same batch is read again, for ever",
      ],
      [
        "stores/mongo-paused-execution.repository.ts",
        "ConditionalExpression",
        "false",
        "if (removed.length === 0) return;",
        "the sweep never returns on an empty round: it asks again for ever",
      ],
      [
        "stores/mongo-paused-execution.repository.ts",
        "EqualityOperator",
        "removed.length !== 0",
        "if (removed.length === 0) return;",
        "the sweep returns on a round that removed something and asks again for ever on an empty one",
      ],
      [
        "stores/paused/pause-scans.ts",
        "ArrayDeclaration",
        '["Stryker was here"]',
        "const removable: PauseDocument[] = [];",
        "the list starts with a record that has no `_id`: the sweep's delete by ids removes nothing, and the same page is read again, for ever",
      ],
      [
        // NOT a hang proved: the same mutant applied by hand to a scratch copy fails five tests of this shard
        // (the retention's conformance cases, pause-reassign-edges, pause-transaction-commands, pause-scan-keys),
        // none of them ending at a hit limit; under Stryker it runs 3346 times against a limit of 2700 in one of
        // the covering tests before an assertion fails it. It is not a survivor, and it is listed so that it is
        // reviewed once and not hidden (agbossjs/mongodb#103); finding the test that loops is its own follow-up
        "stores/mongo-paused-execution.repository.ts",
        "ObjectLiteral",
        "{}",
        ".deleteMany({ _id: { $in: ids } }, { session });",
        "the delete's filter is emptied and removes every pause (killed by five tests when run by hand), and Stryker ends it at its hit limit first",
      ],
    ].map(([file, mutator, replacement, anchor, reason]) => ({
      file,
      mutator,
      replacement,
      anchor,
      kind: "hit-limit",
      reason,
    })),
  ],
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
