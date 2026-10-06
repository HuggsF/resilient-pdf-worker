import type { Channel } from 'amqplib';
import {
  DEAD_LETTER_EXCHANGE,
  DEAD_LETTER_ROUTING_KEY,
  assertTopology,
  describeTopology,
} from '@infrastructure/queue/certificate-topology';

describe('certificate topology', () => {
  const topology = describeTopology([1000, 4000, 16_000, 30_000, 4000]);

  it('declares the main queue exactly as in the SPEC (durable + dead-letter exchange)', () => {
    expect(topology.queues[0]).toEqual({
      name: 'certificate.generate',
      options: {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': 'certificate.dlx',
          'x-dead-letter-routing-key': 'certificate.dlq',
        },
      },
    });
    expect(DEAD_LETTER_EXCHANGE).toBe('certificate.dlx');
    expect(DEAD_LETTER_ROUTING_KEY).toBe('certificate.dlq');
  });

  it('binds the DLQ to the dead-letter exchange', () => {
    expect(topology.exchanges).toEqual([{ name: 'certificate.dlx', type: 'direct' }]);
    expect(topology.queues[1]).toEqual({ name: 'certificate.dlq', options: { durable: true } });
    expect(topology.bindings).toEqual([
      { queue: 'certificate.dlq', exchange: 'certificate.dlx', routingKey: 'certificate.dlq' },
    ]);
  });

  it('declares one TTL queue per distinct delay, dead-lettering back to the main queue', () => {
    const retryQueues = topology.queues.slice(2);

    expect(retryQueues.map((queue) => queue.name)).toEqual([
      'certificate.retry.1s',
      'certificate.retry.4s',
      'certificate.retry.16s',
      'certificate.retry.30s',
    ]);
    expect(retryQueues[1]?.options).toEqual({
      durable: true,
      arguments: {
        'x-message-ttl': 4000,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': 'certificate.generate',
      },
    });
  });

  it('asserts exchanges, then queues, then bindings', async () => {
    const calls: string[] = [];
    const channel = {
      assertExchange: (name: string) => {
        calls.push(`exchange:${name}`);
        return Promise.resolve({ exchange: name });
      },
      assertQueue: (name: string) => {
        calls.push(`queue:${name}`);
        return Promise.resolve({ queue: name, messageCount: 0, consumerCount: 0 });
      },
      bindQueue: (queue: string, exchange: string) => {
        calls.push(`bind:${exchange}->${queue}`);
        return Promise.resolve({});
      },
    } as unknown as Channel;

    await assertTopology(channel, describeTopology([1000]));

    expect(calls).toEqual([
      'exchange:certificate.dlx',
      'queue:certificate.generate',
      'queue:certificate.dlq',
      'queue:certificate.retry.1s',
      'bind:certificate.dlx->certificate.dlq',
    ]);
  });
});
