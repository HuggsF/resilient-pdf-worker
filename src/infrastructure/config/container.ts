import type { ChannelModel } from 'amqplib';
import type { Knex } from 'knex';
import type { HealthIndicator } from '@application/interfaces/health-indicator';
import type { Logger } from '@application/interfaces/logger';
import { CERTIFICATE_QUEUES } from '@application/services/certificate-queues';
import { CheckHealthUseCase } from '@application/use-cases/check-health.use-case';
import { EnqueueCertificateUseCase } from '@application/use-cases/enqueue-certificate.use-case';
import { GenerateCertificateUseCase } from '@application/use-cases/generate-certificate.use-case';
import { GetCertificateStatsUseCase } from '@application/use-cases/get-certificate-stats.use-case';
import { GetCertificateStatusUseCase } from '@application/use-cases/get-certificate-status.use-case';
import { MonitorDlqDepthUseCase } from '@application/use-cases/monitor-dlq-depth.use-case';
import { ReprocessDlqUseCase } from '@application/use-cases/reprocess-dlq.use-case';
import { RetryStrategy } from '@domain/services/retry-strategy';
import type { AppConfig } from '@infrastructure/config/env';
import { createDatabase, pingDatabase } from '@infrastructure/database/knex';
import { MySqlCertificateRepository } from '@infrastructure/database/mysql-certificate.repository';
import { CircuitBreakerPdfGenerator } from '@infrastructure/http/circuit-breaker-pdf-generator';
import { HttpPdfGeneratorService } from '@infrastructure/http/http-pdf-generator.service';
import type { ShutdownTask } from '@infrastructure/lifecycle/graceful-shutdown';
import { LogAlarmService } from '@infrastructure/monitoring/log-alarm.service';
import { describeTopology } from '@infrastructure/queue/certificate-topology';
import type { Topology } from '@infrastructure/queue/certificate-topology';
import { connectRabbitMq } from '@infrastructure/queue/rabbitmq-connection';
import { RabbitMqMessageBroker } from '@infrastructure/queue/rabbitmq-message-broker';
import { SystemClock } from '@infrastructure/system/system-clock';
import { UuidV7IdGenerator } from '@infrastructure/system/uuid-v7-id-generator';

export const PDF_API_CIRCUIT_ALARM = 'pdf-api-circuit-open';

export type ContainerOptions = {
  /** Reuse an existing pool (tests). The container then does not close it. */
  readonly db?: Knex;
  /** Called when RabbitMQ drops the connection/channel after startup (crash-only design). */
  readonly onConnectionLost?: (reason: string) => void;
};

type Core = {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly db: Knex;
  readonly connection: ChannelModel;
  readonly broker: RabbitMqMessageBroker;
  readonly repository: MySqlCertificateRepository;
  readonly clock: SystemClock;
  readonly retryStrategy: RetryStrategy;
  readonly topology: Topology;
  readonly pdfClient: HttpPdfGeneratorService;
  readonly shutdownTasks: () => ShutdownTask[];
};

export type ApiContainer = Omit<Core, 'shutdownTasks' | 'pdfClient'> & {
  readonly enqueueCertificate: EnqueueCertificateUseCase;
  readonly getCertificateStatus: GetCertificateStatusUseCase;
  readonly getCertificateStats: GetCertificateStatsUseCase;
  readonly reprocessDlq: ReprocessDlqUseCase;
  readonly checkHealth: CheckHealthUseCase;
  /** Releases RabbitMQ and MySQL resources, in order. */
  readonly shutdownTasks: () => ShutdownTask[];
};

export type WorkerContainer = Omit<Core, 'shutdownTasks' | 'pdfClient'> & {
  readonly pdfGenerator: CircuitBreakerPdfGenerator;
  readonly alarms: LogAlarmService;
  readonly generateCertificate: GenerateCertificateUseCase;
  readonly monitorDlqDepth: MonitorDlqDepthUseCase;
  readonly checkHealth: CheckHealthUseCase;
  readonly shutdownTasks: () => ShutdownTask[];
};

const retryStrategyFrom = (config: AppConfig): RetryStrategy => {
  const result = RetryStrategy.create(config.retry);
  if (!result.success) {
    throw result.error;
  }
  return result.data;
};

/** Delay queues needed by this configuration: one per backoff delay + the deferral delay. */
export const retryDelaysOf = (config: AppConfig, strategy: RetryStrategy): number[] => [
  ...new Set([...strategy.delays, config.worker.deferDelayMs]),
];

const buildCore = async (
  config: AppConfig,
  logger: Logger,
  role: 'api' | 'worker',
  options: ContainerOptions,
): Promise<Core> => {
  const retryStrategy = retryStrategyFrom(config);
  const topology = describeTopology(retryDelaysOf(config, retryStrategy));
  const db = options.db ?? createDatabase(config.database);
  let closing = false;
  const lost = (reason: string): void => {
    if (!closing) {
      options.onConnectionLost?.(reason);
    }
  };

  const connection = await connectRabbitMq({
    ...config.rabbitmq,
    connectionName: `resilient-pdf-worker:${role}`,
    logger,
  });
  connection.on('error', (error: Error) => {
    logger.error({ err: error }, 'RabbitMQ connection error');
  });
  connection.on('close', () => {
    if (!closing) {
      logger.error({}, 'RabbitMQ connection closed unexpectedly');
    }
    lost('rabbitmq-connection-closed');
  });

  const broker = await RabbitMqMessageBroker.create(connection, {
    topology,
    prefetch: config.rabbitmq.prefetch,
    logger,
    onUnexpectedClose: lost,
  });

  return {
    config,
    logger,
    db,
    connection,
    broker,
    repository: new MySqlCertificateRepository(db),
    clock: new SystemClock(),
    retryStrategy,
    topology,
    pdfClient: new HttpPdfGeneratorService({
      baseUrl: config.pdfApi.url,
      timeoutMs: config.circuitBreaker.timeoutMs,
    }),
    shutdownTasks: () => [
      {
        name: 'rabbitmq-channel',
        close: async () => {
          closing = true;
          await broker.close();
        },
      },
      {
        name: 'rabbitmq-connection',
        close: async () => {
          closing = true;
          await connection.close();
        },
      },
      ...(options.db === undefined ? [{ name: 'database', close: () => db.destroy() }] : []),
    ],
  };
};

const healthIndicators = (core: Core): HealthIndicator[] => [
  { name: 'database', check: () => pingDatabase(core.db) },
  {
    name: 'rabbitmq',
    check: async () => {
      if (!core.broker.isOpen) {
        throw new Error('RabbitMQ channel is closed');
      }
      await core.broker.messageCount(CERTIFICATE_QUEUES.generate);
    },
  },
  // Not critical: the API keeps accepting certificates and the worker keeps them safe in the
  // queue while the PDF API is down — that is the whole point of this service.
  { name: 'pdfApi', critical: false, check: () => core.pdfClient.ping() },
];

/** Composition root of the HTTP API (producer) process. */
export const buildApiContainer = async (
  config: AppConfig,
  logger: Logger,
  options: ContainerOptions = {},
): Promise<ApiContainer> => {
  const core = await buildCore(config, logger, 'api', options);
  const { repository, broker, clock, topology } = core;
  const retryQueues = topology.queues
    .map((queue) => queue.name)
    .filter((name) => name.startsWith(`${CERTIFICATE_QUEUES.retryPrefix}.`));

  return {
    ...core,
    enqueueCertificate: new EnqueueCertificateUseCase(
      repository,
      broker,
      new UuidV7IdGenerator(),
      clock,
      logger,
    ),
    getCertificateStatus: new GetCertificateStatusUseCase(repository),
    getCertificateStats: new GetCertificateStatsUseCase(repository, broker, retryQueues, logger),
    reprocessDlq: new ReprocessDlqUseCase(repository, broker, clock, logger, config.reprocess),
    checkHealth: new CheckHealthUseCase(healthIndicators(core), clock),
  };
};

/** Composition root of the worker (consumer) process. */
export const buildWorkerContainer = async (
  config: AppConfig,
  logger: Logger,
  options: ContainerOptions = {},
): Promise<WorkerContainer> => {
  const core = await buildCore(config, logger, 'worker', options);
  const { repository, broker, clock, retryStrategy } = core;
  const alarms = new LogAlarmService(logger, clock);

  const pdfGenerator = new CircuitBreakerPdfGenerator(
    core.pdfClient,
    config.circuitBreaker,
    logger,
    (state) => {
      const update =
        state === 'open'
          ? alarms.trigger(PDF_API_CIRCUIT_ALARM, 1, 0)
          : state === 'closed'
            ? alarms.resolve(PDF_API_CIRCUIT_ALARM, 0, 0)
            : Promise.resolve();
      update.catch((error: unknown) => {
        logger.warn({ err: error }, 'Could not update the circuit breaker alarm');
      });
    },
  );

  const coreTasks = core.shutdownTasks;
  return {
    ...core,
    pdfGenerator,
    alarms,
    generateCertificate: new GenerateCertificateUseCase(
      repository,
      pdfGenerator,
      broker,
      retryStrategy,
      clock,
      logger,
      { deferDelayMs: config.worker.deferDelayMs, maxDeferrals: config.worker.maxDeferrals },
    ),
    monitorDlqDepth: new MonitorDlqDepthUseCase(broker, alarms, {
      alarmName: config.dlqAlarm.name,
      threshold: config.dlqAlarm.threshold,
    }),
    checkHealth: new CheckHealthUseCase(healthIndicators(core), clock),
    shutdownTasks: () => [
      {
        name: 'circuit-breaker',
        close: () => {
          pdfGenerator.shutdown();
          return Promise.resolve();
        },
      },
      ...coreTasks(),
    ],
  };
};
