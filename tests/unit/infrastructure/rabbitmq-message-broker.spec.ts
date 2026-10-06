import type { ChannelModel, ConfirmChannel, Message } from 'amqplib';
import type { ConsumedMessage } from '@application/interfaces/message-broker';
import { describeTopology } from '@infrastructure/queue/certificate-topology';
import { RabbitMqMessageBroker } from '@infrastructure/queue/rabbitmq-message-broker';
import { createLoggerMock } from '../../support/fakes';

describe('RabbitMqMessageBroker', () => {
  const logger = createLoggerMock();
  const topology = describeTopology([1000]);

  let mockChannel: Partial<ConfirmChannel>;
  let mockConnection: Partial<ChannelModel>;
  let eventHandlers: Record<string, ((...args: unknown[]) => void)[]>;

  beforeEach(() => {
    eventHandlers = {};
    mockChannel = {
      on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
        eventHandlers[event] = eventHandlers[event] ?? [];
        eventHandlers[event].push(handler);
        return mockChannel as ConfirmChannel;
      }),
      assertExchange: jest.fn().mockResolvedValue({ exchange: 'test' }),
      assertQueue: jest
        .fn()
        .mockResolvedValue({ queue: 'test', messageCount: 0, consumerCount: 0 }),
      bindQueue: jest.fn().mockResolvedValue({}),
      prefetch: jest.fn().mockResolvedValue({}),
      sendToQueue: jest.fn(),
      consume: jest.fn().mockResolvedValue({ consumerTag: 'tag-1' }),
      cancel: jest.fn().mockResolvedValue({}),
      ack: jest.fn(),
      nack: jest.fn(),
      get: jest.fn(),
      checkQueue: jest
        .fn()
        .mockResolvedValue({ queue: 'certificate.generate', messageCount: 5, consumerCount: 1 }),
      close: jest.fn().mockResolvedValue({}),
    };

    mockConnection = {
      createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
    };
  });

  it('creates the broker, asserts topology, and sets prefetch', async () => {
    const broker = await RabbitMqMessageBroker.create(mockConnection as ChannelModel, {
      topology,
      prefetch: 10,
      logger,
    });

    expect(mockConnection.createConfirmChannel).toHaveBeenCalled();
    expect(mockChannel.prefetch).toHaveBeenCalledWith(10);
    expect(broker.isOpen).toBe(true);
  });

  it('handles channel error and unexpected close events', async () => {
    const onUnexpectedClose = jest.fn();
    const broker = await RabbitMqMessageBroker.create(mockConnection as ChannelModel, {
      topology,
      prefetch: 10,
      logger,
      onUnexpectedClose,
    });

    // Fire error event
    eventHandlers.error?.forEach((fn) => {
      fn(new Error('Channel socket reset'));
    });
    expect(logger.error).toHaveBeenCalled();

    // Fire close event
    eventHandlers.close?.forEach((fn) => {
      fn();
    });
    expect(broker.isOpen).toBe(false);
    expect(onUnexpectedClose).toHaveBeenCalledWith('channel closed');
  });

  it('handles returned messages (unroutable publish)', async () => {
    const broker = await RabbitMqMessageBroker.create(mockConnection as ChannelModel, {
      topology,
      prefetch: 10,
      logger,
    });

    (mockChannel.sendToQueue as jest.Mock).mockImplementation(
      (
        _queue: string,
        _content: Buffer,
        opts: { correlationId: string },
        callback: (error: Error | null) => void,
      ) => {
        const returnMsg = {
          fields: { routingKey: 'certificate.generate' },
          properties: { correlationId: opts.correlationId, messageId: 'm-unroutable' },
        } as unknown as Message;
        eventHandlers.return?.forEach((fn) => {
          fn(returnMsg);
        });
        callback(null);
        return true;
      },
    );

    await expect(broker.publish('certificate.generate', Buffer.from('{"data":1}'))).rejects.toThrow(
      'Message to "certificate.generate" was unroutable',
    );
  });

  it('rejects publishing to an undeclared queue', async () => {
    const broker = await RabbitMqMessageBroker.create(mockConnection as ChannelModel, {
      topology,
      prefetch: 10,
      logger,
    });

    await expect(broker.publish('unknown.queue', Buffer.from('test'))).rejects.toThrow(
      'Queue "unknown.queue" is not part of the declared topology',
    );
  });

  it('publishes successfully when RabbitMQ confirms the message', async () => {
    const broker = await RabbitMqMessageBroker.create(mockConnection as ChannelModel, {
      topology,
      prefetch: 10,
      logger,
    });

    (mockChannel.sendToQueue as jest.Mock).mockImplementation(
      (
        _queue: string,
        _content: Buffer,
        _opts: unknown,
        callback: (error: Error | null) => void,
      ) => {
        callback(null);
        return true;
      },
    );

    await expect(
      broker.publish('certificate.generate', Buffer.from('{"data":1}'), { messageId: 'm-1' }),
    ).resolves.toBeUndefined();

    expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
      'certificate.generate',
      expect.any(Buffer),
      expect.objectContaining({ messageId: 'm-1', persistent: true, mandatory: true }),
      expect.any(Function),
    );
  });

  it('rejects publish when RabbitMQ returns an error callback', async () => {
    const broker = await RabbitMqMessageBroker.create(mockConnection as ChannelModel, {
      topology,
      prefetch: 10,
      logger,
    });

    (mockChannel.sendToQueue as jest.Mock).mockImplementation(
      (
        _queue: string,
        _content: Buffer,
        _opts: unknown,
        callback: (error: Error | null) => void,
      ) => {
        callback(new Error('Nack received'));
        return true;
      },
    );

    await expect(broker.publish('certificate.generate', Buffer.from('{"data":1}'))).rejects.toThrow(
      'RabbitMQ did not confirm the message: Nack received',
    );
  });

  it('handles message consumption and acking', async () => {
    let messageCallback: (msg: Message | null) => void = () => undefined;
    (mockChannel.consume as jest.Mock).mockImplementation(
      (_queue: string, onMsg: (msg: Message | null) => void) => {
        messageCallback = onMsg;
        return Promise.resolve({ consumerTag: 'test-consumer' });
      },
    );

    const broker = await RabbitMqMessageBroker.create(mockConnection as ChannelModel, {
      topology,
      prefetch: 10,
      logger,
    });

    const captured: { message: ConsumedMessage | null } = { message: null };
    const handler = jest.fn().mockImplementation((consumed: ConsumedMessage) => {
      captured.message = consumed;
      broker.ack(consumed);
      return Promise.resolve();
    });

    await broker.consume('certificate.generate', handler);

    const rawMessage = {
      content: Buffer.from('{"test": true}'),
      properties: { messageId: 'msg-42', headers: { 'x-retry-number': 1 } },
      fields: { redelivered: false, deliveryTag: 123 },
    } as unknown as Message;

    messageCallback(rawMessage);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(mockChannel.ack).toHaveBeenCalledWith(rawMessage);

    // Idempotent settle: calling ack a second time is safely ignored
    if (captured.message !== null) {
      broker.ack(captured.message);
    }
    expect(mockChannel.ack).toHaveBeenCalledTimes(1);
  });

  it('handles consumer cancellation by RabbitMQ (null delivery)', async () => {
    let messageCallback: (msg: Message | null) => void = () => undefined;
    (mockChannel.consume as jest.Mock).mockImplementation(
      (_queue: string, onMsg: (msg: Message | null) => void) => {
        messageCallback = onMsg;
        return Promise.resolve({ consumerTag: 'test-consumer' });
      },
    );

    const broker = await RabbitMqMessageBroker.create(mockConnection as ChannelModel, {
      topology,
      prefetch: 10,
      logger,
    });

    const handler = jest.fn();
    await broker.consume('certificate.generate', handler);

    // RabbitMQ cancelled consumer
    messageCallback(null);

    expect(handler).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      { queue: 'certificate.generate' },
      'Consumer cancelled by RabbitMQ (queue deleted?)',
    );
  });

  it('nacks with requeue when message handler throws', async () => {
    let messageCallback: (msg: Message | null) => void = () => undefined;
    (mockChannel.consume as jest.Mock).mockImplementation(
      (_queue: string, onMsg: (msg: Message | null) => void) => {
        messageCallback = onMsg;
        return Promise.resolve({ consumerTag: 'test-consumer' });
      },
    );

    const broker = await RabbitMqMessageBroker.create(mockConnection as ChannelModel, {
      topology,
      prefetch: 10,
      logger,
    });

    const handler = jest.fn().mockRejectedValue(new Error('Handler crashed'));

    await broker.consume('certificate.generate', handler);

    const rawMessage = {
      content: Buffer.from('{"test": true}'),
      properties: { messageId: 'msg-fail' },
      fields: { redelivered: false },
    } as unknown as Message;

    messageCallback(rawMessage);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockChannel.nack).toHaveBeenCalledWith(rawMessage, false, true);
  });

  it('supports nack without requeue (DLQ routing)', async () => {
    let messageCallback: (msg: Message | null) => void = () => undefined;
    (mockChannel.consume as jest.Mock).mockImplementation(
      (_queue: string, onMsg: (msg: Message | null) => void) => {
        messageCallback = onMsg;
        return Promise.resolve({ consumerTag: 'test-consumer' });
      },
    );

    const broker = await RabbitMqMessageBroker.create(mockConnection as ChannelModel, {
      topology,
      prefetch: 10,
      logger,
    });

    const handler = jest.fn().mockImplementation((msg: ConsumedMessage) => {
      broker.nack(msg, false);
      return Promise.resolve();
    });

    await broker.consume('certificate.generate', handler);

    const rawMessage = {
      content: Buffer.from('{"test": true}'),
      properties: { messageId: 'msg-dlq' },
      fields: { redelivered: false },
    } as unknown as Message;

    messageCallback(rawMessage);

    expect(mockChannel.nack).toHaveBeenCalledWith(rawMessage, false, false);
  });

  it('safely ignores settling of foreign message not from channel', async () => {
    const broker = await RabbitMqMessageBroker.create(mockConnection as ChannelModel, {
      topology,
      prefetch: 10,
      logger,
    });

    const foreignMsg = {
      content: Buffer.from('x'),
      messageId: 'foreign',
      headers: {},
      redelivered: false,
    } as ConsumedMessage;

    broker.ack(foreignMsg);
    expect(logger.warn).toHaveBeenCalledWith(
      { action: 'ack' },
      'Ignoring settle of a message not delivered by this channel',
    );
  });

  it('queries message count and fetches one-off messages via get', async () => {
    const broker = await RabbitMqMessageBroker.create(mockConnection as ChannelModel, {
      topology,
      prefetch: 10,
      logger,
    });

    const count = await broker.messageCount('certificate.generate');
    expect(count).toBe(5);

    (mockChannel.get as jest.Mock).mockResolvedValueOnce({
      content: Buffer.from('hello'),
      properties: { messageId: 'm-single' },
      fields: { redelivered: false },
    });

    const msg = await broker.get('certificate.generate');
    expect(msg).not.toBeNull();
    expect(msg?.messageId).toBe('m-single');

    (mockChannel.get as jest.Mock).mockResolvedValueOnce(false);
    const emptyMsg = await broker.get('certificate.generate');
    expect(emptyMsg).toBeNull();
  });

  it('throws when querying or getting from an unknown queue', async () => {
    const broker = await RabbitMqMessageBroker.create(mockConnection as ChannelModel, {
      topology,
      prefetch: 10,
      logger,
    });

    await expect(broker.messageCount('missing.queue')).rejects.toThrow(
      'Queue "missing.queue" is not part of the declared topology',
    );
    await expect(broker.get('missing.queue')).rejects.toThrow(
      'Queue "missing.queue" is not part of the declared topology',
    );
  });

  it('handles cancel error and channel close errors gracefully on close', async () => {
    (mockChannel.consume as jest.Mock).mockResolvedValueOnce({ consumerTag: 'tag-error' });

    const broker = await RabbitMqMessageBroker.create(mockConnection as ChannelModel, {
      topology,
      prefetch: 10,
      logger,
    });

    await broker.consume('certificate.generate', jest.fn());

    (mockChannel.cancel as jest.Mock).mockRejectedValueOnce(new Error('Cancel failed'));
    (mockChannel.close as jest.Mock).mockRejectedValueOnce(new Error('Already closed'));

    await broker.close();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'Cancel failed' }),
      'Could not cancel consumer',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'Already closed' }),
      'Channel was already closed',
    );

    // Second close is no-op
    await broker.close();
  });
});
