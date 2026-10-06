/**
 * Queue names shared by the producer (API) and the consumer (worker). The topology itself
 * (exchanges, bindings, TTLs, dead-lettering) is declared by the infrastructure adapter.
 */
export const CERTIFICATE_QUEUES = {
  /** Main work queue. Rejected messages are dead-lettered to `certificate.dlq`. */
  generate: 'certificate.generate',
  /** Dead Letter Queue: messages that exhausted their retries (or could not be processed). */
  deadLetter: 'certificate.dlq',
  /** Prefix of the delayed-retry queues (one per delay, see ADR-004). */
  retryPrefix: 'certificate.retry',
} as const;

/** Message headers written by the worker (diagnostics + bounded deferrals). */
export const MESSAGE_HEADERS = {
  retryNumber: 'x-retry-number',
  deferrals: 'x-deferrals',
} as const;

const formatDelay = (delayMs: number): string =>
  delayMs % 1000 === 0 ? `${delayMs / 1000}s` : `${delayMs}ms`;

/**
 * Name of the retry queue that holds a message for `delayMs` before sending it back to
 * `certificate.generate`, e.g. `certificate.retry.4s`.
 */
export const retryQueueName = (delayMs: number): string =>
  `${CERTIFICATE_QUEUES.retryPrefix}.${formatDelay(delayMs)}`;
