export type ReprocessDlqInput = {
  /** Maximum number of DLQ messages handled by this call. */
  readonly limit?: number;
};

export type ReprocessDlqOutput = {
  /** Certificates reset to `pending` and published back to `certificate.generate`. */
  readonly moved: number;
  /** Duplicates of already completed certificates, removed from the DLQ. */
  readonly discarded: number;
  /** Messages left in the DLQ because they cannot be processed (poison / unknown certificate). */
  readonly kept: number;
  /** DLQ depth after this call (`null` if it could not be read). */
  readonly remaining: number | null;
};
