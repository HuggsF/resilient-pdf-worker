import type { ChannelModel } from 'amqplib';
import type { Knex } from 'knex';
import { RetryStrategy } from '@domain/services/retry-strategy';
import {
  buildApiContainer,
  buildWorkerContainer,
  retryDelaysOf,
} from '@infrastructure/config/container';
import type { AppConfig } from '@infrastructure/config/env';
import * as knexModule from '@infrastructure/database/knex';
import * as rabbitMqConnModule from '@infrastructure/queue/rabbitmq-connection';
import { RabbitMqMessageBroker } from '@infrastructure/queue/rabbitmq-message-broker';
import { createLoggerMock } from '../../support/fakes';

jest.mock('@infrastructure/database/knex');
jest.mock('@infrastructure/queue/rabbitmq-connection');
jest.mock('@infrastructure/queue/rabbitmq-message-broker');

describe('Container Composition Root', () => {
  const logger = createLoggerMock();

  const sampleConfig = {
    env: 'test',
    http: { port: 3000 },
    log: { level: 'info', pretty: false },
    shutdownTimeoutMs: 1000,
    database: {
      host: 'localhost',
      port: 3306,
      user: 'root',
      password: 'pwd',
      name: 'app',
      pool: { min: 1, max: 5 },
      migrateOnStart: false,
    },
    rabbitmq: {
      url: 'amqp://localhost:5672',
      prefetch: 10,
      connectRetries: 3,
      connectRetryDelayMs: 10,
    },
    pdfApi: { url: 'http://localhost:4000' },
    circuitBreaker: {
      timeoutMs: 1000,
      errorThresholdPercentage: 50,
      resetTimeoutMs: 5000,
      volumeThreshold: 5,
      rollingWindowMs: 5000,
    },
    retry: { maxRetries: 3, baseDelayMs: 1000, multiplier: 4 },
    worker: { deferDelayMs: 30000, maxDeferrals: 10, httpPort: 3001 },
    dlqAlarm: { name: 'dlq-alarm', threshold: 0, intervalMs: 5000 },
    reprocess: { defaultLimit: 100, maxLimit: 1000 },
  } as unknown as AppConfig;

  let mockConnection: Partial<ChannelModel>;
  let mockBroker: Partial<RabbitMqMessageBroker>;
  let mockDb: Partial<Knex>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConnection = {
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };

    mockBroker = {
      isOpen: true,
      messageCount: jest.fn().mockResolvedValue(0),
      close: jest.fn().mockResolvedValue(undefined),
    };

    mockDb = {
      raw: jest.fn().mockResolvedValue([[{ 1: 1 }]]),
      destroy: jest.fn().mockResolvedValue(undefined),
    };

    (rabbitMqConnModule.connectRabbitMq as jest.Mock).mockResolvedValue(mockConnection);
    (RabbitMqMessageBroker.create as jest.Mock).mockResolvedValue(mockBroker);
    (knexModule.createDatabase as jest.Mock).mockReturnValue(mockDb);
    (knexModule.pingDatabase as jest.Mock).mockResolvedValue(undefined);
  });

  it('computes unique retry delays including deferDelayMs', () => {
    const strategyResult = RetryStrategy.create({
      maxRetries: 3,
      baseDelayMs: 1000,
      multiplier: 4,
    });
    if (!strategyResult.success) throw strategyResult.error;

    const delays = retryDelaysOf(sampleConfig, strategyResult.data);
    expect(delays).toEqual([1000, 4000, 16000, 30000]);
  });

  it('builds the ApiContainer with all use cases and shutdown tasks', async () => {
    const container = await buildApiContainer(sampleConfig, logger);

    expect(container.enqueueCertificate).toBeDefined();
    expect(container.getCertificateStatus).toBeDefined();
    expect(container.getCertificateStats).toBeDefined();
    expect(container.reprocessDlq).toBeDefined();
    expect(container.checkHealth).toBeDefined();

    const tasks = container.shutdownTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    for (const task of tasks) {
      await task.close();
    }
  });

  it('builds the WorkerContainer with all use cases, alarms, and shutdown tasks', async () => {
    const container = await buildWorkerContainer(sampleConfig, logger);

    expect(container.pdfGenerator).toBeDefined();
    expect(container.alarms).toBeDefined();
    expect(container.generateCertificate).toBeDefined();
    expect(container.monitorDlqDepth).toBeDefined();
    expect(container.checkHealth).toBeDefined();

    const tasks = container.shutdownTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    for (const task of tasks) {
      await task.close();
    }
  });
});
