/** The types of `mutation-shards.mjs`, for `vitest.mutation.config.ts`. */
export interface MutationShard {
  readonly mutate: readonly string[];
  readonly tests: readonly string[];
  /** Only the cases whose full name matches it (a regular expression's source). */
  readonly testNamePattern?: string;
  /** Files of `tests` left out. */
  readonly exclude?: readonly string[];
  /** Stryker's `timeoutMS` for the shard, when it needs more than the default (above the shard's whole run). */
  readonly timeoutMS?: number;
}
export declare const SHARDS: Readonly<Record<string, MutationShard>>;
export declare function chosenShard(): MutationShard & { readonly name: string };
