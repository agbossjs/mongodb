/** The types of `stryker-timeouts.mjs`, for its test. */
export interface ProvenHang {
  readonly file: string;
  readonly line: number;
  readonly mutator: string;
  readonly reason: string;
}
export interface StrykerReport {
  readonly files: Readonly<
    Record<
      string,
      {
        readonly mutants: readonly {
          readonly mutatorName: string;
          readonly replacement: string;
          readonly status: string;
          readonly location: { readonly start: { readonly line: number } };
        }[];
      }
    >
  >;
}
export declare const PROVEN_HANGS: Readonly<Record<string, readonly ProvenHang[]>>;
export declare function unprovenTimeouts(
  report: StrykerReport,
  shard: string,
  proven?: Readonly<Record<string, readonly ProvenHang[]>>,
): string[];
export declare function staleHangs(
  report: StrykerReport,
  shard: string,
  proven?: Readonly<Record<string, readonly ProvenHang[]>>,
): ProvenHang[];
