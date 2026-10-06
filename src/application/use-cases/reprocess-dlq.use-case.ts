import type { ReprocessDlqInput, ReprocessDlqOutput } from '@application/dtos/reprocess-dlq.dto';
import { UnexpectedError } from '@application/errors/unexpected.error';
import type { Clock } from '@application/interfaces/clock';
import type { Logger } from '@application/interfaces/logger';
import type { ConsumedMessage, MessageBroker } from '@application/interfaces/message-broker';
import {
  decodeCertificateJob,
  encodeCertificateJob,
} from '@application/services/certificate-job.codec';
import { CERTIFICATE_QUEUES } from '@application/services/certificate-queues';
import type { CertificateRepository } from '@domain/repositories/certificate.repository';
import { fail, ok } from '@domain/shared/result';
import type { Result } from '@domain/shared/result';

export type ReprocessDlqOptions = {
  readonly defaultLimit: number;
  readonly maxLimit: number;
};

type Disposition = 'moved' | 'discarded' | 'kept';

/**
 * Moves messages from `certificate.dlq` back to `certificate.generate` once the PDF API has
 * recovered. For each message: reset the certificate (pending, fresh retry budget) → publish a
 * confirmed copy to the main queue → only then ack the DLQ message. A crash at any point leaves
 * the message in the DLQ (worst case: a duplicate, which the worker's idempotency check absorbs).
 */
export class ReprocessDlqUseCase {
  constructor(
    private readonly repository: CertificateRepository,
    private readonly broker: MessageBroker,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: ReprocessDlqOptions,
  ) {}

  async execute(input: ReprocessDlqInput): Promise<Result<ReprocessDlqOutput, UnexpectedError>> {
    const limit = Math.min(
      Math.max(input.limit ?? this.options.defaultLimit, 1),
      this.options.maxLimit,
    );
    const counts: Record<Disposition, number> = { moved: 0, discarded: 0, kept: 0 };
    // Unprocessable messages stay unacked until the end, otherwise `get` would return them again.
    const kept: ConsumedMessage[] = [];
    let current: ConsumedMessage | null = null;

    try {
      while (counts.moved + counts.discarded + counts.kept < limit) {
        current = await this.broker.get(CERTIFICATE_QUEUES.deadLetter);
        if (current === null) {
          break;
        }
        const disposition = await this.reprocess(current);
        counts[disposition] += 1;
        if (disposition === 'kept') {
          kept.push(current);
        }
        current = null;
      }
    } catch (error: unknown) {
      if (current !== null) {
        this.broker.nack(current, true);
      }
      return fail(new UnexpectedError('Reprocessing the Dead Letter Queue', error));
    } finally {
      for (const message of kept) {
        this.broker.nack(message, true);
      }
    }

    const remaining = await this.remaining();
    this.logger.info({ ...counts, remaining }, 'Dead Letter Queue reprocessed');
    return ok({ ...counts, remaining });
  }

  private async reprocess(message: ConsumedMessage): Promise<Disposition> {
    const job = decodeCertificateJob(message.content);
    if (!job.success) {
      this.logger.warn(
        { messageId: message.messageId, err: job.error },
        'Poison message kept in the DLQ',
      );
      return 'kept';
    }
    const { certificateId } = job.data;
    const certificate = await this.repository.findById(certificateId);
    if (certificate === null) {
      this.logger.warn({ certificateId }, 'DLQ message for an unknown certificate kept in the DLQ');
      return 'kept';
    }
    const requeued = certificate.requeue(this.clock.now());
    if (!requeued.success) {
      // Already completed: this DLQ message is a stale duplicate, drop it.
      this.broker.ack(message);
      return 'discarded';
    }

    await this.repository.save(requeued.data);
    await this.broker.publish(CERTIFICATE_QUEUES.generate, encodeCertificateJob(job.data), {
      messageId: certificateId,
    });
    this.broker.ack(message);
    return 'moved';
  }

  private async remaining(): Promise<number | null> {
    try {
      return await this.broker.messageCount(CERTIFICATE_QUEUES.deadLetter);
    } catch {
      return null;
    }
  }
}
