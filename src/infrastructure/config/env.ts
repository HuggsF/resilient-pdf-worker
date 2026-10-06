import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const booleanFlag = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().min(0);
const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//.test(value), 'must be an http(s) URL');
const amqpUrl = z
  .string()
  .url()
  .refine((value) => /^amqps?:\/\//.test(value), 'must be an amqp(s) URL');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: port.default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_PRETTY: booleanFlag.default('false'),
    SHUTDOWN_TIMEOUT_MS: positiveInt.default(30_000),

    DB_HOST: z.string().min(1),
    DB_PORT: port,
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string(),
    DB_NAME: z.string().min(1),
    DB_POOL_MIN: nonNegativeInt.default(0),
    DB_POOL_MAX: positiveInt.default(10),
    DB_MIGRATE_ON_START: booleanFlag.default('false'),

    RABBITMQ_URL: amqpUrl,
    RABBITMQ_PREFETCH: z.coerce.number().int().min(1).max(1000).default(10),
    RABBITMQ_CONNECT_RETRIES: positiveInt.default(10),
    RABBITMQ_CONNECT_RETRY_DELAY_MS: positiveInt.default(1000),

    PDF_API_URL: httpUrl,

    CB_TIMEOUT_MS: positiveInt.default(10_000),
    CB_ERROR_THRESHOLD_PERCENTAGE: z.coerce.number().min(1).max(100).default(50),
    CB_RESET_TIMEOUT_MS: positiveInt.default(30_000),
    CB_VOLUME_THRESHOLD: nonNegativeInt.default(5),
    CB_ROLLING_WINDOW_MS: positiveInt.default(10_000),

    RETRY_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
    RETRY_BASE_DELAY_MS: positiveInt.default(1000),
    RETRY_MULTIPLIER: z.coerce.number().min(1).max(10).default(4),

    DEFER_DELAY_MS: positiveInt.default(30_000),
    MAX_DEFERRALS: positiveInt.default(120),

    DLQ_ALARM_NAME: z.string().min(1).default('certificate-dlq-depth'),
    DLQ_ALARM_THRESHOLD: nonNegativeInt.default(0),
    DLQ_ALARM_INTERVAL_MS: positiveInt.default(15_000),

    WORKER_HTTP_PORT: port.default(3001),

    REPROCESS_DEFAULT_LIMIT: positiveInt.default(100),
    REPROCESS_MAX_LIMIT: positiveInt.default(1000),
  })
  .refine((env) => env.DB_POOL_MIN <= env.DB_POOL_MAX, {
    message: 'DB_POOL_MIN must be less than or equal to DB_POOL_MAX',
    path: ['DB_POOL_MIN'],
  })
  .refine((env) => env.REPROCESS_DEFAULT_LIMIT <= env.REPROCESS_MAX_LIMIT, {
    message: 'REPROCESS_DEFAULT_LIMIT must be less than or equal to REPROCESS_MAX_LIMIT',
    path: ['REPROCESS_DEFAULT_LIMIT'],
  });

export type LogLevel = z.infer<typeof envSchema>['LOG_LEVEL'];

export type DatabaseConfig = {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly name: string;
  readonly pool: { readonly min: number; readonly max: number };
  readonly migrateOnStart: boolean;
};

export type RabbitMqConfig = {
  readonly url: string;
  readonly prefetch: number;
  readonly connectRetries: number;
  readonly connectRetryDelayMs: number;
};

export type CircuitBreakerConfig = {
  /** Per-call timeout (also the HTTP client timeout). SPEC: 10s. */
  readonly timeoutMs: number;
  /** Opens when more than this % of the calls in the rolling window failed. SPEC: 50. */
  readonly errorThresholdPercentage: number;
  /** Time in OPEN before letting one trial call through (HALF-OPEN). SPEC: 30s. */
  readonly resetTimeoutMs: number;
  /** Minimum calls in the window before the breaker may open. SPEC: 5. */
  readonly volumeThreshold: number;
  readonly rollingWindowMs: number;
};

export type AppConfig = {
  readonly env: 'development' | 'test' | 'production';
  readonly http: { readonly port: number };
  readonly log: { readonly level: LogLevel; readonly pretty: boolean };
  readonly database: DatabaseConfig;
  readonly rabbitmq: RabbitMqConfig;
  readonly pdfApi: { readonly url: string };
  readonly circuitBreaker: CircuitBreakerConfig;
  readonly retry: {
    readonly maxRetries: number;
    readonly baseDelayMs: number;
    readonly multiplier: number;
  };
  readonly worker: {
    readonly httpPort: number;
    readonly deferDelayMs: number;
    readonly maxDeferrals: number;
  };
  readonly dlqAlarm: {
    readonly name: string;
    readonly threshold: number;
    readonly intervalMs: number;
  };
  readonly reprocess: { readonly defaultLimit: number; readonly maxLimit: number };
  readonly shutdownTimeoutMs: number;
};

export class ConfigValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
  }
}

/** Loads `.env` (if present) into process.env without overriding variables already set. */
export const loadEnvFile = (path?: string): void => {
  loadDotenv({ path, quiet: true });
};

/** Validates the environment once at startup: the process refuses to boot with a bad configuration. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  const vars = parsed.data;

  return {
    env: vars.NODE_ENV,
    http: { port: vars.PORT },
    log: { level: vars.LOG_LEVEL, pretty: vars.LOG_PRETTY },
    database: {
      host: vars.DB_HOST,
      port: vars.DB_PORT,
      user: vars.DB_USER,
      password: vars.DB_PASSWORD,
      name: vars.DB_NAME,
      pool: { min: vars.DB_POOL_MIN, max: vars.DB_POOL_MAX },
      migrateOnStart: vars.DB_MIGRATE_ON_START,
    },
    rabbitmq: {
      url: vars.RABBITMQ_URL,
      prefetch: vars.RABBITMQ_PREFETCH,
      connectRetries: vars.RABBITMQ_CONNECT_RETRIES,
      connectRetryDelayMs: vars.RABBITMQ_CONNECT_RETRY_DELAY_MS,
    },
    pdfApi: { url: vars.PDF_API_URL },
    circuitBreaker: {
      timeoutMs: vars.CB_TIMEOUT_MS,
      errorThresholdPercentage: vars.CB_ERROR_THRESHOLD_PERCENTAGE,
      resetTimeoutMs: vars.CB_RESET_TIMEOUT_MS,
      volumeThreshold: vars.CB_VOLUME_THRESHOLD,
      rollingWindowMs: vars.CB_ROLLING_WINDOW_MS,
    },
    retry: {
      maxRetries: vars.RETRY_MAX_RETRIES,
      baseDelayMs: vars.RETRY_BASE_DELAY_MS,
      multiplier: vars.RETRY_MULTIPLIER,
    },
    worker: {
      httpPort: vars.WORKER_HTTP_PORT,
      deferDelayMs: vars.DEFER_DELAY_MS,
      maxDeferrals: vars.MAX_DEFERRALS,
    },
    dlqAlarm: {
      name: vars.DLQ_ALARM_NAME,
      threshold: vars.DLQ_ALARM_THRESHOLD,
      intervalMs: vars.DLQ_ALARM_INTERVAL_MS,
    },
    reprocess: {
      defaultLimit: vars.REPROCESS_DEFAULT_LIMIT,
      maxLimit: vars.REPROCESS_MAX_LIMIT,
    },
    shutdownTimeoutMs: vars.SHUTDOWN_TIMEOUT_MS,
  };
};
