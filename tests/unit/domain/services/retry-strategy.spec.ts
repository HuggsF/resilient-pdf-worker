import { InvalidRetryStrategyError } from '@domain/errors/invalid-retry-strategy.error';
import { MaxRetriesExceededError } from '@domain/errors/max-retries-exceeded.error';
import { RetryStrategy } from '@domain/services/retry-strategy';
import type { RetryStrategyOptions } from '@domain/services/retry-strategy';
import { aCertificate, inState } from '../../../support/fakes';

const strategy = (options?: RetryStrategyOptions): RetryStrategy => {
  const result = RetryStrategy.create(options);
  if (!result.success) throw result.error;
  return result.data;
};

/** A certificate that failed `attempts` times. */
const failedTimes = (attempts: number): ReturnType<typeof aCertificate> => {
  let certificate = aCertificate();
  for (let i = 0; i < attempts; i += 1) {
    certificate = inState(certificate, 'processing', 'failed');
  }
  return certificate;
};

describe('RetryStrategy (exponential backoff)', () => {
  it('uses the SPEC defaults: 3 retries after 1s, 4s and 16s (4 attempts in total)', () => {
    const retry = strategy();

    expect(retry.maxRetries).toBe(3);
    expect(retry.maxAttempts).toBe(4);
    expect(retry.delays).toEqual([1000, 4000, 16_000]);
    expect([1, 2, 3].map((n) => retry.delayForRetry(n))).toEqual([1000, 4000, 16_000]);
  });

  it('grows exponentially with any base and multiplier', () => {
    expect(strategy({ maxRetries: 4, baseDelayMs: 100, multiplier: 2 }).delays).toEqual([
      100, 200, 400, 800,
    ]);
    expect(strategy({ maxRetries: 3, baseDelayMs: 500, multiplier: 1 }).delays).toEqual([
      500, 500, 500,
    ]);
  });

  it('caps every delay at maxDelayMs', () => {
    expect(
      strategy({ maxRetries: 4, baseDelayMs: 1000, multiplier: 4, maxDelayMs: 10_000 }).delays,
    ).toEqual([1000, 4000, 10_000, 10_000]);
  });

  it('clamps out-of-range retry numbers', () => {
    const retry = strategy();

    expect(retry.delayForRetry(0)).toBe(1000);
    expect(retry.delayForRetry(99)).toBe(16_000);
  });

  it('allows no retry at all with maxRetries = 0', () => {
    const retry = strategy({ maxRetries: 0, baseDelayMs: 1000, multiplier: 4 });

    expect(retry.maxAttempts).toBe(1);
    expect(retry.delays).toEqual([]);
    expect(retry.delayForRetry(1)).toBe(0);
    expect(retry.nextRetry(failedTimes(1)).success).toBe(false);
  });

  describe('nextRetry', () => {
    it.each([
      [1, 1, 1000],
      [2, 2, 4000],
      [3, 3, 16_000],
    ])(
      'after %i failed attempt(s) schedules retry #%i in %i ms',
      (attempts, retryNumber, delayMs) => {
        expect(strategy().nextRetry(failedTimes(attempts))).toEqual({
          success: true,
          data: { retryNumber, delayMs },
        });
      },
    );

    it('gives up after the 4th failed attempt', () => {
      const result = strategy().nextRetry(failedTimes(4));

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(MaxRetriesExceededError);
        expect(result.error).toMatchObject({ attempts: 4, maxAttempts: 4 });
        expect(result.error.message).toContain('failed 4 of 4 allowed attempts');
      }
    });

    it('never schedules a retry for a certificate that was not attempted', () => {
      expect(strategy().nextRetry(aCertificate()).success).toBe(false);
    });
  });

  it.each<[RetryStrategyOptions, string]>([
    [{ maxRetries: -1, baseDelayMs: 1000, multiplier: 4 }, 'maxRetries'],
    [{ maxRetries: 11, baseDelayMs: 1000, multiplier: 4 }, 'maxRetries'],
    [{ maxRetries: 1.5, baseDelayMs: 1000, multiplier: 4 }, 'maxRetries'],
    [{ maxRetries: 3, baseDelayMs: 0, multiplier: 4 }, 'baseDelayMs'],
    [{ maxRetries: 3, baseDelayMs: 1000, multiplier: 0.5 }, 'multiplier'],
    [{ maxRetries: 3, baseDelayMs: 1000, multiplier: Number.NaN }, 'multiplier'],
    [{ maxRetries: 3, baseDelayMs: 1000, multiplier: 4, maxDelayMs: 10 }, 'maxDelayMs'],
  ])('rejects invalid options %p', (options, field) => {
    const result = RetryStrategy.create(options);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(InvalidRetryStrategyError);
      expect(result.error.message).toContain(field);
    }
  });
});
