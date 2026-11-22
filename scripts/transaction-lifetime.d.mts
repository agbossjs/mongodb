/** The types of `transaction-lifetime.mjs`. */
export declare function withTransactionLifetime<T>(
  url: string,
  seconds: number,
  run: () => Promise<T>,
): Promise<T>;
