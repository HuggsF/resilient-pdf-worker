import { ConfigValidationError, loadConfig } from '@infrastructure/config/env';

const REQUIRED = {
  DB_HOST: 'localhost',
  DB_PORT: '3306',
  DB_USER: 'root',
  DB_PASSWORD: 'secret',
  DB_NAME: 'pdf_worker',
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
  PDF_API_URL: 'http://localhost:4000',
};

describe('loadConfig', () => {
  it('applies the SPEC defaults to every optional variable', () => {
    expect(loadConfig(REQUIRED)).toEqual({
      env: 'development',
      http: { port: 3000 },
      log: { level: 'info', pretty: false },
      database: {
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: 'secret',
        name: 'pdf_worker',
        pool: { min: 0, max: 10 },
        migrateOnStart: false,
      },
      rabbitmq: {
        url: 'amqp://guest:guest@localhost:5672',
        prefetch: 10,
        connectRetries: 10,
        connectRetryDelayMs: 1000,
      },
      pdfApi: { url: 'http://localhost:4000' },
      circuitBreaker: {
        timeoutMs: 10_000,
        errorThresholdPercentage: 50,
        resetTimeoutMs: 30_000,
        volumeThreshold: 5,
        rollingWindowMs: 10_000,
      },
      retry: { maxRetries: 3, baseDelayMs: 1000, multiplier: 4 },
      worker: { httpPort: 3001, deferDelayMs: 30_000, maxDeferrals: 120 },
      dlqAlarm: { name: 'certificate-dlq-depth', threshold: 0, intervalMs: 15_000 },
      reprocess: { defaultLimit: 100, maxLimit: 1000 },
      shutdownTimeoutMs: 30_000,
    });
  });

  it('coerces numbers and boolean flags', () => {
    const config = loadConfig({
      ...REQUIRED,
      PORT: '8080',
      LOG_PRETTY: 'true',
      DB_MIGRATE_ON_START: '1',
      RETRY_BASE_DELAY_MS: '50',
      CB_ERROR_THRESHOLD_PERCENTAGE: '75.5',
      DB_PASSWORD: '',
    });

    expect(config.http.port).toBe(8080);
    expect(config.log.pretty).toBe(true);
    expect(config.database.migrateOnStart).toBe(true);
    expect(config.retry.baseDelayMs).toBe(50);
    expect(config.circuitBreaker.errorThresholdPercentage).toBe(75.5);
    expect(config.database.password).toBe('');
  });

  it('lists every invalid variable', () => {
    const load = (): unknown =>
      loadConfig({
        ...REQUIRED,
        DB_PORT: 'abc',
        RABBITMQ_URL: 'http://localhost:5672',
        PDF_API_URL: 'ftp://pdf',
        RETRY_MAX_RETRIES: '11',
        LOG_LEVEL: 'loud',
      });

    expect(load).toThrow(ConfigValidationError);
    try {
      load();
    } catch (error: unknown) {
      const issues = (error as ConfigValidationError).issues.join('\n');
      expect(issues).toContain('DB_PORT');
      expect(issues).toContain('RABBITMQ_URL: must be an amqp(s) URL');
      expect(issues).toContain('PDF_API_URL: must be an http(s) URL');
      expect(issues).toContain('RETRY_MAX_RETRIES');
      expect(issues).toContain('LOG_LEVEL');
    }
  });

  it('requires the connection settings', () => {
    expect(() => loadConfig({})).toThrow(/DB_HOST[\s\S]*RABBITMQ_URL[\s\S]*PDF_API_URL/);
  });

  it.each([
    [{ DB_POOL_MIN: '20', DB_POOL_MAX: '10' }, 'DB_POOL_MIN'],
    [{ REPROCESS_DEFAULT_LIMIT: '50', REPROCESS_MAX_LIMIT: '10' }, 'REPROCESS_DEFAULT_LIMIT'],
  ])('checks cross-field constraints %p', (overrides, field) => {
    expect(() => loadConfig({ ...REQUIRED, ...overrides })).toThrow(field);
  });
});
