import { setTimeout as sleep } from 'node:timers/promises';
import { connect } from 'amqplib';
import type { ChannelModel } from 'amqplib';
import type { Logger } from '@application/interfaces/logger';
import type { RabbitMqConfig } from '@infrastructure/config/env';

export type RabbitMqConnectionOptions = Pick<
  RabbitMqConfig,
  'url' | 'connectRetries' | 'connectRetryDelayMs'
> & {
  /** Shown in the RabbitMQ management UI (Connections tab). */
  readonly connectionName: string;
  readonly logger: Logger;
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Connects to RabbitMQ, retrying with a linear backoff while the broker is still booting.
 * After startup a lost connection is fatal on purpose (crash-only design): the process exits
 * and its supervisor (Docker `restart`, ECS, Kubernetes) restarts it; unacked messages are
 * redelivered by RabbitMQ, so nothing is lost.
 */
export const connectRabbitMq = async (
  options: RabbitMqConnectionOptions,
): Promise<ChannelModel> => {
  const { url, connectRetries, connectRetryDelayMs, connectionName, logger } = options;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const connection = await connect(url, {
        clientProperties: { connection_name: connectionName },
      });
      logger.info({ attempt, connectionName }, 'Connected to RabbitMQ');
      return connection;
    } catch (error: unknown) {
      if (attempt >= connectRetries) {
        throw new Error(
          `Could not connect to RabbitMQ after ${attempt} attempts: ${describe(error)}`,
          {
            cause: error,
          },
        );
      }
      const delayMs = connectRetryDelayMs * attempt;
      logger.warn(
        { attempt, delayMs, err: describe(error) },
        'RabbitMQ not reachable yet, retrying',
      );
      await sleep(delayMs);
    }
  }
};
