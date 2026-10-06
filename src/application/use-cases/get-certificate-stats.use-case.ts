import type { CertificateStatsOutput, QueueDepthsOutput } from '@application/dtos/certificate.dto';
import { UnexpectedError } from '@application/errors/unexpected.error';
import type { Logger } from '@application/interfaces/logger';
import type { MessageBroker } from '@application/interfaces/message-broker';
import { CERTIFICATE_QUEUES } from '@application/services/certificate-queues';
import type { CertificateRepository } from '@domain/repositories/certificate.repository';
import { fail, ok } from '@domain/shared/result';
import type { Result } from '@domain/shared/result';

/**
 * Status dashboard: certificates per status (MySQL) and messages per queue (RabbitMQ). Together
 * they prove that nothing is lost: every non-final certificate has a message somewhere.
 */
export class GetCertificateStatsUseCase {
  constructor(
    private readonly repository: CertificateRepository,
    private readonly broker: Pick<MessageBroker, 'messageCount'>,
    private readonly retryQueues: readonly string[],
    private readonly logger: Logger,
  ) {}

  async execute(): Promise<Result<CertificateStatsOutput, UnexpectedError>> {
    let byStatus: CertificateStatsOutput['byStatus'];
    try {
      byStatus = await this.repository.countByStatus();
    } catch (error: unknown) {
      return fail(new UnexpectedError('Counting certificates', error));
    }
    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    return ok({ total, byStatus, queues: await this.queueDepths() });
  }

  private async queueDepths(): Promise<QueueDepthsOutput | null> {
    try {
      const [generate, deadLetter, retries] = await Promise.all([
        this.broker.messageCount(CERTIFICATE_QUEUES.generate),
        this.broker.messageCount(CERTIFICATE_QUEUES.deadLetter),
        Promise.all(this.retryQueues.map((queue) => this.broker.messageCount(queue))),
      ]);
      return {
        generate,
        retry: retries.reduce((sum, count) => sum + count, 0),
        deadLetter,
      };
    } catch (error: unknown) {
      this.logger.warn({ err: error }, 'Queue depths unavailable');
      return null;
    }
  }
}
