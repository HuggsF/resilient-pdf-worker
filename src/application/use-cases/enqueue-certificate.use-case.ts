import type {
  EnqueueCertificateInput,
  EnqueueCertificateOutput,
} from '@application/dtos/certificate.dto';
import { QueueUnavailableError } from '@application/errors/queue-unavailable.error';
import { UnexpectedError } from '@application/errors/unexpected.error';
import type { Clock } from '@application/interfaces/clock';
import type { IdGenerator } from '@application/interfaces/id-generator';
import type { Logger } from '@application/interfaces/logger';
import type { MessageBroker } from '@application/interfaces/message-broker';
import { encodeCertificateJob } from '@application/services/certificate-job.codec';
import { CERTIFICATE_QUEUES } from '@application/services/certificate-queues';
import { Certificate } from '@domain/entities/certificate.entity';
import type { InvalidCertificateError } from '@domain/errors/invalid-certificate.error';
import type { CertificateRepository } from '@domain/repositories/certificate.repository';
import { fail, ok } from '@domain/shared/result';
import type { Result } from '@domain/shared/result';
import { CompletionDate } from '@domain/value-objects/completion-date.value-object';

export type EnqueueCertificateError =
  InvalidCertificateError | QueueUnavailableError | UnexpectedError;

/**
 * Producer use case (HTTP API): validates the request, records the certificate as `pending`
 * and publishes a job to `certificate.generate`. Answers as soon as RabbitMQ confirmed the
 * message — the PDF is generated asynchronously by the worker.
 */
export class EnqueueCertificateUseCase {
  constructor(
    private readonly repository: CertificateRepository,
    private readonly broker: MessageBroker,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async execute(
    input: EnqueueCertificateInput,
  ): Promise<Result<EnqueueCertificateOutput, EnqueueCertificateError>> {
    const now = this.clock.now();
    const created = Certificate.create({
      id: this.idGenerator.generate(),
      studentId: input.studentId,
      studentName: input.studentName,
      courseName: input.courseName,
      completionDate: input.completionDate ?? CompletionDate.fromInstant(now).value,
      createdAt: now,
    });
    if (!created.success) {
      return created;
    }
    const certificate = created.data;

    try {
      await this.repository.save(certificate);
    } catch (error: unknown) {
      return fail(new UnexpectedError('Saving the certificate', error));
    }

    try {
      await this.broker.publish(
        CERTIFICATE_QUEUES.generate,
        encodeCertificateJob({ certificateId: certificate.id }),
        { messageId: certificate.id },
      );
    } catch (error: unknown) {
      // The row stays `pending` without a message: logged with its id so it can be re-enqueued
      // (a transactional outbox would close this gap — see README "Known limitations").
      this.logger.error(
        { certificateId: certificate.id, err: error },
        'Certificate saved but its job could not be published',
      );
      return fail(new QueueUnavailableError(error));
    }

    this.logger.info({ certificateId: certificate.id }, 'Certificate generation enqueued');
    return ok({ certificateId: certificate.id, status: certificate.status });
  }
}
