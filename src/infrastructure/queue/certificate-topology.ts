import type { Channel, Options } from 'amqplib';
import { CERTIFICATE_QUEUES, retryQueueName } from '@application/services/certificate-queues';

export const DEAD_LETTER_EXCHANGE = 'certificate.dlx';
export const DEAD_LETTER_ROUTING_KEY = 'certificate.dlq';

export type QueueDeclaration = {
  readonly name: string;
  readonly options: Options.AssertQueue;
};

export type Topology = {
  readonly exchanges: readonly { readonly name: string; readonly type: 'direct' }[];
  readonly queues: readonly QueueDeclaration[];
  readonly bindings: readonly {
    readonly queue: string;
    readonly exchange: string;
    readonly routingKey: string;
  }[];
};

/**
 * Declarative RabbitMQ topology:
 *
 *   certificate.generate ──nack(requeue=false)──► certificate.dlx ──► certificate.dlq
 *        ▲
 *        └── TTL expired ── certificate.retry.<delay>   (one queue per delay: 1s, 4s, 16s, 30s…)
 *
 * The worker *publishes* a copy to a retry queue (instead of dead-lettering into it), so the
 * message never cycles through dead-lettering and RabbitMQ's cycle detection never drops it.
 * One queue per delay avoids head-of-line blocking of per-message TTLs (ADR-004).
 */
export const describeTopology = (delaysMs: readonly number[]): Topology => {
  const retryQueues = [...new Set(delaysMs)]
    .sort((a, b) => a - b)
    .map((delayMs): QueueDeclaration => ({
      name: retryQueueName(delayMs),
      options: {
        durable: true,
        arguments: {
          'x-message-ttl': delayMs,
          // Default exchange + queue name as routing key = straight back to the main queue.
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': CERTIFICATE_QUEUES.generate,
        },
      },
    }));

  return {
    exchanges: [{ name: DEAD_LETTER_EXCHANGE, type: 'direct' }],
    queues: [
      {
        name: CERTIFICATE_QUEUES.generate,
        options: {
          durable: true,
          arguments: {
            'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
            'x-dead-letter-routing-key': DEAD_LETTER_ROUTING_KEY,
          },
        },
      },
      { name: CERTIFICATE_QUEUES.deadLetter, options: { durable: true } },
      ...retryQueues,
    ],
    bindings: [
      {
        queue: CERTIFICATE_QUEUES.deadLetter,
        exchange: DEAD_LETTER_EXCHANGE,
        routingKey: DEAD_LETTER_ROUTING_KEY,
      },
    ],
  };
};

/** Idempotent: re-declaring with the same arguments is a no-op for RabbitMQ. */
export const assertTopology = async (channel: Channel, topology: Topology): Promise<void> => {
  for (const exchange of topology.exchanges) {
    await channel.assertExchange(exchange.name, exchange.type, { durable: true });
  }
  for (const queue of topology.queues) {
    await channel.assertQueue(queue.name, queue.options);
  }
  for (const binding of topology.bindings) {
    await channel.bindQueue(binding.queue, binding.exchange, binding.routingKey);
  }
};
