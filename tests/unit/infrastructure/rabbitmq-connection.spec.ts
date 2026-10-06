import * as amqplib from 'amqplib';
import { connectRabbitMq } from '@infrastructure/queue/rabbitmq-connection';
import { createLoggerMock } from '../../support/fakes';

jest.mock('amqplib');

describe('connectRabbitMq', () => {
  const logger = createLoggerMock();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('connects successfully on the first attempt', async () => {
    const fakeConn = { on: jest.fn() };
    (amqplib.connect as jest.Mock).mockResolvedValueOnce(fakeConn);

    const conn = await connectRabbitMq({
      url: 'amqp://localhost:5672',
      connectRetries: 3,
      connectRetryDelayMs: 10,
      connectionName: 'test-conn',
      logger,
    });

    expect(conn).toBe(fakeConn);
    expect(amqplib.connect).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { attempt: 1, connectionName: 'test-conn' },
      'Connected to RabbitMQ',
    );
  });

  it('retries when connection fails and succeeds on a subsequent attempt', async () => {
    const fakeConn = { on: jest.fn() };
    (amqplib.connect as jest.Mock)
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValueOnce(fakeConn);

    const conn = await connectRabbitMq({
      url: 'amqp://localhost:5672',
      connectRetries: 3,
      connectRetryDelayMs: 5,
      connectionName: 'test-retry',
      logger,
    });

    expect(conn).toBe(fakeConn);
    expect(amqplib.connect).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('throws an error when all connect retries are exhausted', async () => {
    (amqplib.connect as jest.Mock).mockRejectedValue(new Error('Broker offline'));

    await expect(
      connectRabbitMq({
        url: 'amqp://localhost:5672',
        connectRetries: 2,
        connectRetryDelayMs: 5,
        connectionName: 'test-exhausted',
        logger,
      }),
    ).rejects.toThrow('Could not connect to RabbitMQ after 2 attempts: Broker offline');

    expect(amqplib.connect).toHaveBeenCalledTimes(2);
  });

  it('handles non-Error rejection gracefully', async () => {
    (amqplib.connect as jest.Mock).mockRejectedValue('String error failure');

    await expect(
      connectRabbitMq({
        url: 'amqp://localhost:5672',
        connectRetries: 1,
        connectRetryDelayMs: 5,
        connectionName: 'test-string-err',
        logger,
      }),
    ).rejects.toThrow('Could not connect to RabbitMQ after 1 attempts: String error failure');
  });
});
