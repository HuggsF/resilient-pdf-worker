export interface HealthIndicator {
  readonly name: string;
  /**
   * A critical dependency being down makes the service unavailable (HTTP 503). A non-critical
   * one only degrades it: e.g. the API keeps accepting certificates while the PDF API is down —
   * which is the whole point of the queue. Default: true.
   */
  readonly critical?: boolean;
  /** Resolves when the dependency is reachable, rejects otherwise. */
  check(): Promise<void>;
}
