import type { Certificate } from '@domain/entities/certificate.entity';
import { InvalidRetryStrategyError } from '@domain/errors/invalid-retry-strategy.error';
import { MaxRetriesExceededError } from '@domain/errors/max-retries-exceeded.error';
import { fail, ok } from '@domain/shared/result';
import type { Result } from '@domain/shared/result';

export type RetryStrategyOptions = {
  /** Retries after the first attempt (SPEC: 3). Total attempts = maxRetries + 1. */
  readonly maxRetries: number;
  /** Delay before the first retry (SPEC: 1s). */
  readonly baseDelayMs: number;
  /** Growth factor between retries (SPEC: 4 → 1s, 4s, 16s). */
  readonly multiplier: number;
  /** Upper bound for any single delay. Default: no cap besides the computed delays. */
  readonly maxDelayMs?: number;
};

export type RetryDecision = {
  /** 1 for the first retry. */
  readonly retryNumber: number;
  readonly delayMs: number;
};

const MAX_RETRIES_LIMIT = 10;
const MAX_DELAY_LIMIT_MS = 24 * 60 * 60 * 1000;

/**
 * Exponential backoff: `delay(n) = baseDelayMs × multiplier^(n-1)`, i.e. 1s → 4s → 16s with the
 * SPEC defaults. Decides whether a failed certificate deserves another attempt and how long it
 * must wait; *how* the wait happens (TTL queues) is an infrastructure concern.
 */
export class RetryStrategy {
  static readonly DEFAULTS: RetryStrategyOptions = {
    maxRetries: 3,
    baseDelayMs: 1000,
    multiplier: 4,
  };

  /** Delay before each retry, index 0 = first retry. */
  readonly delays: readonly number[];

  private constructor(
    readonly maxRetries: number,
    delays: readonly number[],
  ) {
    this.delays = Object.freeze([...delays]);
    Object.freeze(this);
  }

  static create(
    options: RetryStrategyOptions = RetryStrategy.DEFAULTS,
  ): Result<RetryStrategy, InvalidRetryStrategyError> {
    const { maxRetries, baseDelayMs, multiplier } = options;
    const maxDelayMs = options.maxDelayMs ?? MAX_DELAY_LIMIT_MS;

    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_RETRIES_LIMIT) {
      return fail(
        new InvalidRetryStrategyError(
          `maxRetries must be an integer between 0 and ${MAX_RETRIES_LIMIT}`,
        ),
      );
    }
    if (!Number.isInteger(baseDelayMs) || baseDelayMs < 1) {
      return fail(new InvalidRetryStrategyError('baseDelayMs must be a positive integer'));
    }
    if (!Number.isFinite(multiplier) || multiplier < 1) {
      return fail(new InvalidRetryStrategyError('multiplier must be a number >= 1'));
    }
    if (
      !Number.isInteger(maxDelayMs) ||
      maxDelayMs < baseDelayMs ||
      maxDelayMs > MAX_DELAY_LIMIT_MS
    ) {
      return fail(
        new InvalidRetryStrategyError(
          'maxDelayMs must be an integer between baseDelayMs and 24 hours',
        ),
      );
    }

    const delays = Array.from({ length: maxRetries }, (_, index) =>
      Math.min(Math.round(baseDelayMs * multiplier ** index), maxDelayMs),
    );
    return ok(new RetryStrategy(maxRetries, delays));
  }

  /** First attempt + retries. */
  get maxAttempts(): number {
    return this.maxRetries + 1;
  }

  /** Delay before retry number `retryNumber` (1-based). Out-of-range numbers are clamped. */
  delayForRetry(retryNumber: number): number {
    const index = Math.min(Math.max(Math.trunc(retryNumber), 1), this.maxRetries) - 1;
    return this.delays[index] ?? 0;
  }

  /**
   * Called after a failed attempt: the certificate has made `attempts` attempts so far, so the
   * next one is retry number `attempts`. Once the budget is spent → `MaxRetriesExceededError`.
   */
  nextRetry(certificate: Certificate): Result<RetryDecision, MaxRetriesExceededError> {
    if (!certificate.canRetry(this.maxAttempts) || certificate.attempts < 1) {
      return fail(
        new MaxRetriesExceededError(certificate.id, certificate.attempts, this.maxAttempts),
      );
    }
    const retryNumber = certificate.attempts;
    return ok({ retryNumber, delayMs: this.delayForRetry(retryNumber) });
  }
}
