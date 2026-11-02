/**
 * The collections of the MongoDB stores (agbossjs/agboss#527), one name per kind of document. Every
 * collection is created by `ensureSchema` with the simple (binary) collation, so a key is compared
 * byte for byte — `Zoë-17`, `Zoe-17` and `Zoë-17` are three keys, never one.
 */
export const Collections = {
  /** One document per tree: its latest lease (`ExecutionLeaseRepository`). */
  ExecutionLeases: "agboss_execution_leases",
  /** One document per execution id ever handed out (agbossjs/agboss#591): never removed. */
  ExecutionIds: "agboss_execution_ids",
  /** One document per lease scope: the highest token that wrote it (#500). */
  FencedEffectMarks: "agboss_fenced_effect_marks",
  /** One document per fenced effect key: its stored result (#500, #508). */
  FencedEffectResults: "agboss_fenced_effect_results",
  /** One document per key a fenced effect or an outbound call is writing: the lock of its row. */
  FencedKeyLocks: "agboss_fenced_key_locks",
  /** One document per intent of a call that leaves the system (agbossjs/agboss#505). */
  OutboundCalls: "agboss_outbound_calls",
  /** The lease log (#501): one document per event, never changed. */
  ExecutionLeaseEvents: "agboss_execution_lease_events",
  /** Threads with their owners (#265 S30). */
  Threads: "agboss_threads",
  /** One record per execution, in the order appended. */
  ExecutionRecords: "agboss_execution_records",
  /** Quality scores of records (#78). */
  ExecutionScores: "agboss_execution_scores",
  /** Resolved configs first seen under a version (#78). */
  ConfigVersions: "agboss_config_versions",
  /** Conversation memory summaries (#77). */
  ExecutionSummaries: "agboss_execution_summaries",
  /** The permanent log of resolved pauses. */
  PauseAnswers: "agboss_pause_answers",
  /** One document per key of a tree (`ExecutionTreeRepository`). */
  ExecutionTreeKeys: "agboss_execution_tree_keys",
  /** One paused run per thread of a tenant. */
  PausedExecutions: "agboss_paused_executions",
  /** One document per pause (#267 S35). */
  Pauses: "agboss_pauses",
  /** The children queued for any instance (#333). */
  ChildExecutionQueue: "agboss_child_execution_queue",
  /** One counter per budget, scope, scope key and period (agbossjs/agboss#483). */
  CostCounters: "agboss_cost_counters",
  /** The last `maxSpend()` read per budget, scope and scope key. */
  CostMaxSpend: "agboss_cost_max_spend",
  /** One document per kept root execution (agbossjs/agboss#483). */
  ExecutionHistory: "agboss_execution_history",
  /** One document per rate-limit key: its slots. */
  RateLimitSlots: "agboss_rate_limit_slots",
  /** One document per rate-limit window: its buckets. */
  RateLimitWindows: "agboss_rate_limit_windows",
  /** One document per paused provider (a 429, an open breaker). */
  RateLimitPauses: "agboss_rate_limit_pauses",
  /** One document per trusted mesh request (agbossjs/agboss#483). */
  MeshRequests: "agboss_mesh_requests",
  /** LangGraph's checkpoints. */
  Checkpoints: "agboss_checkpoints",
  /** LangGraph's pending writes of a checkpoint. */
  CheckpointWrites: "agboss_checkpoint_writes",
  /** The sequences that order what is read "in the order appended". */
  Sequences: "agboss_sequences",
} as const;

/** One collection's name. */
export type CollectionName = (typeof Collections)[keyof typeof Collections];
