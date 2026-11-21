/** The types of `stryker-timeouts.mjs`, for its test. */
export interface ProvenHang {
  readonly file: string;
  readonly mutator: string;
  readonly replacement: string;
  readonly anchor: string;
  readonly kind: "hit-limit" | "wall-clock";
  readonly reason: string;
}
export interface StrykerReport {
  readonly files: Readonly<
    Record<
      string,
      {
        readonly source?: string;
        readonly mutants: readonly {
          readonly mutatorName: string;
          readonly replacement: string;
          readonly status: string;
          readonly statusReason?: string;
          readonly location: { readonly start: { readonly line: number } };
        }[];
      }
    >
  >;
}
type Proven = Readonly<Record<string, readonly ProvenHang[]>>;
export declare const PROVEN_HANGS: Proven;
export declare function unprovenTimeouts(
  report: StrykerReport,
  shard: string,
  proven?: Proven,
): string[];
export declare function erroredMutants(report: StrykerReport): string[];
export declare function staleHangs(
  report: StrykerReport,
  shard: string,
  proven?: Proven,
): ProvenHang[];
