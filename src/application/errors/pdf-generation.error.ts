import { ApplicationError } from './application.error';

/**
 * Why a PDF could not be generated:
 * - `circuit_open`     the circuit breaker rejected the call: the API was **not** called
 * - `timeout`          no answer within the deadline
 * - `server_error`     HTTP 5xx
 * - `rate_limited`     HTTP 429 / 408
 * - `network`          connection refused/reset, DNS…
 * - `invalid_response` 2xx without a usable PDF URL
 * - `rejected`         HTTP 4xx: the request itself is invalid, retrying cannot help
 */
export type PdfGenerationFailureKind =
  | 'circuit_open'
  | 'timeout'
  | 'server_error'
  | 'rate_limited'
  | 'network'
  | 'invalid_response'
  | 'rejected';

export class PdfGenerationError extends ApplicationError {
  readonly code = 'PDF_GENERATION_FAILED';

  constructor(
    readonly kind: PdfGenerationFailureKind,
    message: string,
    readonly statusCode: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  /** Transient failures are worth another attempt; a rejected request is not. */
  get retryable(): boolean {
    return this.kind !== 'rejected';
  }

  /** False when the request never reached the API (circuit open): it must not count as an attempt. */
  get attempted(): boolean {
    return this.kind !== 'circuit_open';
  }
}
