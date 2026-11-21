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
    ].map(([file, mutator, replacement, anchor, reason]) => ({
      file,
      mutator,
      replacement,
      anchor,
      kind: "hit-limit",
      reason,
    })),
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
