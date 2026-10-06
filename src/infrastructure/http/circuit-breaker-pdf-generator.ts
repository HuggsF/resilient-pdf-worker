import CircuitBreaker from 'opossum';
import { PdfGenerationError } from '@application/errors/pdf-generation.error';
import type { Logger } from '@application/interfaces/logger';
import type {
  PdfGenerationData,
  PdfGeneratorService,
} from '@application/interfaces/pdf-generator.service';
import { fail, ok } from '@domain/shared/result';
import type { Result } from '@domain/shared/result';
import type { CircuitBreakerConfig } from '@infrastructure/config/env';

export type CircuitState = 'closed' | 'open' | 'half_open';

export type CircuitBreakerMetrics = {
  readonly state: CircuitState;
  /** State transitions since start. */
  readonly opened: number;
  readonly halfOpened: number;
  readonly closed: number;
  /** Calls since start, by outcome. */
  readonly calls: number;
  readonly successes: number;
  readonly failures: number;
  readonly timeouts: number;
  /** Calls short-circuited while OPEN (the API was not called). */
  readonly rejected: number;
};

type Counters = Record<Exclude<keyof CircuitBreakerMetrics, 'state'>, number>;

const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

/**
 * Decorator: wraps any PdfGeneratorService in an opossum circuit breaker.
 *
 *   CLOSED ──(> errorThreshold% of ≥ volumeThreshold calls fail)──► OPEN
 *   OPEN ──(resetTimeout)──► HALF-OPEN ──(1 trial call ok)──► CLOSED / (fails) ──► OPEN
 *
 * While OPEN, calls fail immediately with kind `circuit_open` — the use case then parks the
 * message without spending an attempt. A 4xx (`rejected`) means the API is healthy and the
 * request is wrong, so it does not count as a breaker failure.
 */
export class CircuitBreakerPdfGenerator implements PdfGeneratorService {
  private readonly breaker: CircuitBreaker<[PdfGenerationData], string>;
  private readonly counters: Counters = {
    opened: 0,
    halfOpened: 0,
    closed: 0,
    calls: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    rejected: 0,
  };

  constructor(
    inner: PdfGeneratorService,
    private readonly options: CircuitBreakerConfig,
    logger: Logger,
    onStateChange?: (state: CircuitState) => void,
  ) {
    this.breaker = new CircuitBreaker(
      async (data: PdfGenerationData): Promise<string> => {
        const result = await inner.generate(data);
        if (!result.success) {
          throw result.error;
        }
        return result.data;
      },
      {
        name: 'pdf-api',
        timeout: options.timeoutMs,
        errorThresholdPercentage: options.errorThresholdPercentage,
        resetTimeout: options.resetTimeoutMs,
        volumeThreshold: options.volumeThreshold,
        rollingCountTimeout: options.rollingWindowMs,
        errorFilter: (error: unknown) =>
          error instanceof PdfGenerationError && error.kind === 'rejected',
      },
    );

    this.breaker.on('fire', () => {
      this.counters.calls += 1;
    });
    this.breaker.on('success', () => {
      this.counters.successes += 1;
    });
    this.breaker.on('failure', () => {
      this.counters.failures += 1;
    });
    this.breaker.on('timeout', () => {
      this.counters.timeouts += 1;
    });
    this.breaker.on('reject', () => {
      this.counters.rejected += 1;
    });
    this.breaker.on('open', () => {
      this.counters.opened += 1;
      logger.warn(
        { breaker: 'pdf-api', resetTimeoutMs: options.resetTimeoutMs },
        'Circuit breaker OPEN: PDF API calls suspended',
      );
      onStateChange?.('open');
    });
    this.breaker.on('halfOpen', () => {
      this.counters.halfOpened += 1;
      logger.info({ breaker: 'pdf-api' }, 'Circuit breaker HALF-OPEN: sending a trial request');
      onStateChange?.('half_open');
    });
    this.breaker.on('close', () => {
      this.counters.closed += 1;
      logger.info({ breaker: 'pdf-api' }, 'Circuit breaker CLOSED: PDF API recovered');
      onStateChange?.('closed');
    });
  }

  async generate(data: PdfGenerationData): Promise<Result<string, PdfGenerationError>> {
    try {
      return ok(await this.breaker.fire(data));
    } catch (error: unknown) {
      return fail(this.toPdfGenerationError(error));
    }
  }

  get state(): CircuitState {
    if (this.breaker.opened) {
      return 'open';
    }
    return this.breaker.halfOpen ? 'half_open' : 'closed';
  }

  metrics(): CircuitBreakerMetrics {
    return { state: this.state, ...this.counters };
  }

  /** Clears opossum's timers (rolling window, reset timeout). */
  shutdown(): void {
    this.breaker.shutdown();
  }

  private toPdfGenerationError(error: unknown): PdfGenerationError {
    if (error instanceof PdfGenerationError) {
      return error;
    }
    switch (codeOf(error)) {
      case 'EOPENBREAKER':
        return new PdfGenerationError(
          'circuit_open',
          'Circuit breaker is open: PDF API calls are suspended',
        );
      case 'ETIMEDOUT':
        return new PdfGenerationError(
          'timeout',
          `PDF API did not answer within ${this.options.timeoutMs} ms`,
        );
      case 'ESHUTDOWN':
        return new PdfGenerationError('circuit_open', 'Circuit breaker is shut down');
      default:
        return new PdfGenerationError(
          'network',
          error instanceof Error ? error.message : String(error),
          null,
          { cause: error },
        );
    }
  }
}
