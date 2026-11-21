/** The types of `mutation-shards.mjs`, for `vitest.mutation.config.ts`. */
export interface MutationShard {
  readonly mutate: readonly string[];
  readonly tests: readonly string[];
  /** The stores of the conformance file the shard runs (keys of `storeConformance`'s `stores`); none: all. */
  readonly contracts?: readonly string[];
  /** Files of `tests` left out. */
  readonly exclude?: readonly string[];
  /** Stryker's `timeoutMS` for the shard, when it needs more than the default (above the shard's whole run). */
  readonly timeoutMS?: number;
  /** Stryker's `concurrency` for the shard, when three mutants at a time starve the servers. */
  readonly concurrency?: number;
}
export declare const SHARDS: Readonly<Record<string, MutationShard>>;
export declare function chosenShard(): MutationShard & { readonly name: string };
