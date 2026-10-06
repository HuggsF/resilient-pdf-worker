import { setTimeout as sleep } from 'node:timers/promises';
import { PdfGenerationError } from '@application/errors/pdf-generation.error';
import type { PdfGenerationData } from '@application/interfaces/pdf-generator.service';
import type { CircuitBreakerConfig } from '@infrastructure/config/env';
import { CircuitBreakerPdfGenerator } from '@infrastructure/http/circuit-breaker-pdf-generator';
import type { CircuitState } from '@infrastructure/http/circuit-breaker-pdf-generator';
import { ScriptedPdfGenerator, createLoggerMock } from '../../support/fakes';

const DATA: PdfGenerationData = {
  certificateId: 'c-1',
  studentId: 's-1',
  studentName: 'Ana Souza',
  courseName: 'Node.js',
  completionDate: '2026-02-20',
};

/** SPEC thresholds (50 %, volume 5) with short timings so the test runs in milliseconds. */
const OPTIONS: CircuitBreakerConfig = {
  timeoutMs: 100,
  errorThresholdPercentage: 50,
  resetTimeoutMs: 80,
  volumeThreshold: 5,
  rollingWindowMs: 10_000,
};

describe('CircuitBreakerPdfGenerator', () => {
  const breakers: CircuitBreakerPdfGenerator[] = [];
  const create = (
    inner: ScriptedPdfGenerator | { generate: ScriptedPdfGenerator['generate'] },
    onStateChange?: (state: CircuitState) => void,
  ): CircuitBreakerPdfGenerator => {
    const breaker = new CircuitBreakerPdfGenerator(
      inner,
      OPTIONS,
      createLoggerMock(),
      onStateChange,
    );
    breakers.push(breaker);
    return breaker;
  };

  afterEach(() => {
    for (const breaker of breakers.splice(0)) breaker.shutdown();
  });

  it('passes successful calls through', async () => {
    const breaker = create(new ScriptedPdfGenerator('https://cdn.example.edu/a.pdf'));

    expect(await breaker.generate(DATA)).toEqual({
      success: true,
      data: 'https://cdn.example.edu/a.pdf',
    });
    expect(breaker.state).toBe('closed');
  });

  it('opens after the volume threshold is reached with > 50 % failures, then fails fast', async () => {
    const inner = new ScriptedPdfGenerator('server_error');
    const states: CircuitState[] = [];
    const breaker = create(inner, (state) => states.push(state));

    const failures = [];
    for (let call = 0; call < 5; call += 1) failures.push(await breaker.generate(DATA));
    const shortCircuited = await breaker.generate(DATA);

    expect(
      failures.every((result) => !result.success && result.error.kind === 'server_error'),
    ).toBe(true);
    expect(breaker.state).toBe('open');
    expect(states).toEqual(['open']);
    expect(shortCircuited.success).toBe(false);
    if (!shortCircuited.success) {
      expect(shortCircuited.error.kind).toBe('circuit_open');
      expect(shortCircuited.error.attempted).toBe(false);
    }
    // The 6th call never reached the API.
    expect(inner.calls).toHaveLength(5);
    expect(breaker.metrics()).toMatchObject({
      state: 'open',
      opened: 1,
      calls: 6,
      failures: 5,
      rejected: 1,
    });
  });

  it('does not open below the volume threshold', async () => {
    const breaker = create(new ScriptedPdfGenerator('server_error'));

    for (let call = 0; call < 4; call += 1) await breaker.generate(DATA);

    expect(breaker.state).toBe('closed');
  });

  it('goes HALF-OPEN after resetTimeout and closes when the trial call succeeds', async () => {
    const inner = new ScriptedPdfGenerator(
      'server_error',
      'server_error',
      'server_error',
      'server_error',
      'server_error',
      'https://cdn.example.edu/recovered.pdf',
    );
    const states: CircuitState[] = [];
    const breaker = create(inner, (state) => states.push(state));
    for (let call = 0; call < 5; call += 1) await breaker.generate(DATA);

    await sleep(OPTIONS.resetTimeoutMs + 40);
    expect(breaker.state).toBe('half_open');
    const trial = await breaker.generate(DATA);

    expect(trial.success).toBe(true);
    expect(breaker.state).toBe('closed');
    expect(states).toEqual(['open', 'half_open', 'closed']);
  });

  it('re-opens when the half-open trial fails', async () => {
    const breaker = create(new ScriptedPdfGenerator('server_error'));
    for (let call = 0; call < 5; call += 1) await breaker.generate(DATA);
    await sleep(OPTIONS.resetTimeoutMs + 40);

    await breaker.generate(DATA);

    expect(breaker.state).toBe('open');
    expect(breaker.metrics().opened).toBe(2);
  });

  it('does not count a rejected request (4xx) as a breaker failure', async () => {
    const breaker = create(new ScriptedPdfGenerator('rejected'));

    const results = [];
    for (let call = 0; call < 8; call += 1) results.push(await breaker.generate(DATA));

    expect(breaker.state).toBe('closed');
    expect(results.every((result) => !result.success && result.error.kind === 'rejected')).toBe(
      true,
    );
  });

  it('times out slow calls (opossum timeout) and maps them to kind "timeout"', async () => {
    const slow = {
      generate: async (): ReturnType<ScriptedPdfGenerator['generate']> => {
        await sleep(OPTIONS.timeoutMs * 3);
        return { success: true, data: 'https://cdn.example.edu/late.pdf' };
      },
    };
    const breaker = create(slow);

    const result = await breaker.generate(DATA);

    expect(!result.success && result.error.kind).toBe('timeout');
    expect(breaker.metrics().timeouts).toBe(1);
  });

  it('maps unexpected exceptions of the wrapped client to kind "network"', async () => {
    const throwing = {
      generate: (): ReturnType<ScriptedPdfGenerator['generate']> =>
        Promise.reject(new Error('socket hang up')),
    };

    const result = await create(throwing).generate(DATA);

    expect(!result.success && result.error).toBeInstanceOf(PdfGenerationError);
    expect(!result.success && result.error.kind).toBe('network');
    expect(!result.success && result.error.message).toBe('socket hang up');
  });

  it('rejects calls after shutdown', async () => {
    const breaker = create(new ScriptedPdfGenerator());
    breaker.shutdown();

    const result = await breaker.generate(DATA);

    expect(!result.success && result.error.kind).toBe('circuit_open');
  });
});
