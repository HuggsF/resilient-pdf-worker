import { randomUUID } from 'node:crypto';
import type { ChannelModel, ConfirmChannel, Message } from 'amqplib';
import type { Logger } from '@application/interfaces/logger';
import type {
  ConsumedMessage,
  MessageBroker,
  MessageHandler,
  PublishOptions,
} from '@application/interfaces/message-broker';
import { assertTopology } from './certificate-topology';
import type { Topology } from './certificate-topology';

export type RabbitMqMessageBrokerOptions = {
  readonly topology: Topology;
  /** Unacked deliveries per consumer: bounds the work in flight in one worker process. */
  readonly prefetch: number;
  readonly logger: Logger;
  /** Called when the channel closes without `close()` being called (broker restart, channel error). */
  readonly onUnexpectedClose?: (reason: string) => void;
};

type Delivery = { readonly raw: Message; settled: boolean };

type PendingPublish = { returned: boolean };

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * amqplib adapter of the MessageBroker port.
 *
 * - **Confirm channel**: `publish` resolves only when RabbitMQ has taken responsibility for
 *   the message (persisted to disk for durable queues + persistent messages).
 * - **Persistent messages** (`deliveryMode: 2`) on **durable** queues survive a broker restart.
 * - **Manual acks** + `prefetch`: a delivery stays owned by RabbitMQ until the use case acks it.
 * - **mandatory** publishes: an unroutable message (queue deleted) rejects the publish instead
 *   of being silently dropped.
 */
export class RabbitMqMessageBroker implements MessageBroker {
  private readonly deliveries = new WeakMap<ConsumedMessage, Delivery>();
  private readonly pendingPublishes = new Map<string, PendingPublish>();
  private readonly knownQueues: ReadonlySet<string>;
  private readonly consumerTags = new Set<string>();
  private closing = false;
  private closed = false;

  private constructor(
    private readonly channel: ConfirmChannel,
    private readonly logger: Logger,
    topology: Topology,
  ) {
    this.knownQueues = new Set(topology.queues.map((queue) => queue.name));
  }

  /** Opens a confirm channel, declares the topology and applies the prefetch limit. */
  static async create(
    connection: ChannelModel,
    options: RabbitMqMessageBrokerOptions,
  ): Promise<RabbitMqMessageBroker> {
    const channel = await connection.createConfirmChannel();
    const broker = new RabbitMqMessageBroker(channel, options.logger, options.topology);

    channel.on('error', (error: Error) => {
      options.logger.error({ err: error }, 'RabbitMQ channel error');
    });
    channel.on('close', () => {
      broker.closed = true;
      if (!broker.closing) {
        options.logger.error({}, 'RabbitMQ channel closed unexpectedly');
        options.onUnexpectedClose?.('channel closed');
      }
    });
    channel.on('return', (message: Message) => {
      const correlationId = String(message.properties.correlationId ?? '');
      const pending = broker.pendingPublishes.get(correlationId);
      if (pending) {
        pending.returned = true;
      }
      options.logger.error(
        {
          routingKey: message.fields.routingKey,
          messageId: message.properties.messageId as unknown,
        },
        'Unroutable message returned by RabbitMQ',
      );
    });

    await assertTopology(channel, options.topology);
    await channel.prefetch(options.prefetch);
    return broker;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  publish(queue: string, message: Buffer, options: PublishOptions = {}): Promise<void> {
    if (!this.knownQueues.has(queue)) {
      return Promise.reject(new Error(`Queue "${queue}" is not part of the declared topology`));
    }
    const correlationId = randomUUID();
    const pending: PendingPublish = { returned: false };
    this.pendingPublishes.set(correlationId, pending);

    return new Promise<void>((resolve, reject) => {
      const settle = (error: unknown): void => {
        this.pendingPublishes.delete(correlationId);
        if (error) {
          reject(new Error(`RabbitMQ did not confirm the message: ${describe(error)}`));
        } else if (pending.returned) {
          reject(new Error(`Message to "${queue}" was unroutable`));
        } else {
          resolve();
        }
      };
      try {
        this.channel.sendToQueue(
          queue,
          message,
          {
            persistent: true,
            mandatory: true,
            contentType: 'application/json',
            correlationId,
            timestamp: Math.floor(Date.now() / 1000),
            ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
            ...(options.headers === undefined ? {} : { headers: { ...options.headers } }),
          },
          settle,
        );
      } catch (error: unknown) {
        // The channel is closed: amqplib throws synchronously.
        settle(error);
      }
    });
  }

  async consume(queue: string, handler: MessageHandler): Promise<void> {
    const { consumerTag } = await this.channel.consume(
      queue,
      (raw) => {
        if (raw === null) {
          this.logger.error({ queue }, 'Consumer cancelled by RabbitMQ (queue deleted?)');
          return;
        }
        const message = this.wrap(raw);
        void handler(message).catch((error: unknown) => {
          this.logger.error(
            { err: error, queue },
            'Message handler failed, requeueing the message',
          );
          this.nack(message, true);
        });
      },
      { noAck: false },
    );
    this.consumerTags.add(consumerTag);
  }

  async stopConsuming(): Promise<void> {
    const tags = [...this.consumerTags];
    this.consumerTags.clear();
    for (const tag of tags) {
      try {
        await this.channel.cancel(tag);
      } catch (error: unknown) {
        this.logger.warn({ err: describe(error), consumerTag: tag }, 'Could not cancel consumer');
      }
    }
  }

  ack(message: ConsumedMessage): void {
    this.settle(message, 'ack', (raw) => {
      this.channel.ack(raw);
    });
  }

  nack(message: ConsumedMessage, requeue: boolean): void {
    this.settle(message, requeue ? 'nack-requeue' : 'nack', (raw) => {
      this.channel.nack(raw, false, requeue);
    });
  }

  async get(queue: string): Promise<ConsumedMessage | null> {
    this.ensureKnown(queue);
    const raw = await this.channel.get(queue, { noAck: false });
    return raw === false ? null : this.wrap(raw);
  }

  async messageCount(queue: string): Promise<number> {
    this.ensureKnown(queue);
    const { messageCount } = await this.channel.checkQueue(queue);
    return messageCount;
  }

  /** Stops consuming and closes the channel (unacked deliveries go back to their queue). */
  async close(): Promise<void> {
    if (this.closing) {
      return;
    }
    this.closing = true;
    await this.stopConsuming();
    if (!this.closed) {
      try {
        await this.channel.close();
      } catch (error: unknown) {
        this.logger.warn({ err: describe(error) }, 'Channel was already closed');
      }
    }
  }

  private wrap(raw: Message): ConsumedMessage {
    const message: ConsumedMessage = Object.freeze({
      content: raw.content,
      messageId: typeof raw.properties.messageId === 'string' ? raw.properties.messageId : null,
      headers: { ...raw.properties.headers },
      redelivered: raw.fields.redelivered,
    });
    this.deliveries.set(message, { raw, settled: false });
    return message;
  }

  /** Each delivery is settled exactly once: a second ack/nack would close the channel. */
  private settle(
    message: ConsumedMessage,
    action: string,
    operation: (raw: Message) => void,
  ): void {
    const delivery = this.deliveries.get(message);
    if (delivery === undefined) {
      this.logger.warn({ action }, 'Ignoring settle of a message not delivered by this channel');
      return;
    }
    if (delivery.settled) {
      this.logger.warn({ action, messageId: message.messageId }, 'Message already settled');
      return;
    }
    delivery.settled = true;
    try {
      operation(delivery.raw);
    } catch (error: unknown) {
      // Channel gone: RabbitMQ will redeliver the message to another consumer.
      this.logger.warn(
        { action, messageId: message.messageId, err: describe(error) },
        'Could not settle the message, RabbitMQ will redeliver it',
      );
    }
  }

  private ensureKnown(queue: string): void {
    if (!this.knownQueues.has(queue)) {
      // checkQueue/get on a missing queue would close the whole channel (404).
      throw new Error(`Queue "${queue}" is not part of the declared topology`);
    }
  }
}
