import type {
  DeadLetterReason,
  DeferralReason,
  GenerateCertificateInput,
  GenerateCertificateOptions,
  GenerateCertificateOutcome,
} from '@application/dtos/generate-certificate.dto';
import { PdfGenerationError } from '@application/errors/pdf-generation.error';
import { UnexpectedError } from '@application/errors/unexpected.error';
import type { Clock } from '@application/interfaces/clock';
import type { Logger } from '@application/interfaces/logger';
import type { ConsumedMessage, MessageBroker } from '@application/interfaces/message-broker';
import type { PdfGeneratorService } from '@application/interfaces/pdf-generator.service';
import { decodeCertificateJob } from '@application/services/certificate-job.codec';
import { toPdfGenerationData } from '@application/services/certificate.mapper';
import { MESSAGE_HEADERS, retryQueueName } from '@application/services/certificate-queues';
import type { Certificate } from '@domain/entities/certificate.entity';
import type { CertificateRepository } from '@domain/repositories/certificate.repository';
import type { RetryStrategy } from '@domain/services/retry-strategy';
import { fail, ok } from '@domain/shared/result';
import type { Result } from '@domain/shared/result';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const readCounter = (headers: Readonly<Record<string, unknown>>, name: string): number => {
  const value = headers[name];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
};

/** Fails loudly on a transition the state machine guarantees (programming error, not a rule). */
const unwrap = <T>(result: Result<T, Error>): T => {
  if (!result.success) {
    throw result.error;
  }
  return result.data;
};

/**
 * Worker use case — handles ONE delivery of `certificate.generate` and settles it exactly once.
 *
 * Invariant: the message is acked only after the outcome is durable — either the certificate
 * status is persisted (completed), or a confirmed copy of the message exists in a delay queue
 * (retry / deferral). Every other path is a `nack`: `requeue=false` dead-letters the message to
 * `certificate.dlq`, `requeue=true` hands it back to RabbitMQ. A message is never lost.
 *
 *   completed ──────────────► ack
 *   failed, retries left ───► publish to certificate.retry.<1s|4s|16s> (confirmed) → ack
 *   failed, budget spent ───► nack(requeue=false) → certificate.dlx → certificate.dlq
 *   circuit open ───────────► attempt NOT counted, parked in the defer queue → ack
 */
export class GenerateCertificateUseCase {
  constructor(
    private readonly repository: CertificateRepository,
    private readonly pdfGenerator: PdfGeneratorService,
    private readonly broker: MessageBroker,
    private readonly retryStrategy: RetryStrategy,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: GenerateCertificateOptions,
  ) {}

  async execute(
    input: GenerateCertificateInput,
  ): Promise<Result<GenerateCertificateOutcome, UnexpectedError>> {
    const { message } = input;
    const job = decodeCertificateJob(message.content);
    if (!job.success) {
      this.logger.error(
        { messageId: message.messageId, err: job.error },
        'Poison message sent to the DLQ',
      );
      this.broker.nack(message, false);
      return ok({
        kind: 'dead_lettered',
        certificateId: null,
        reason: 'invalid_message',
        error: job.error.message,
      });
    }

    const { certificateId } = job.data;
    try {
      return ok(await this.process(certificateId, message));
    } catch (error: unknown) {
      return this.deferAfterInfrastructureFailure(certificateId, message, error);
    }
  }

  private async process(
    certificateId: string,
    message: ConsumedMessage,
  ): Promise<GenerateCertificateOutcome> {
    const certificate = await this.repository.findById(certificateId);
    if (certificate === null) {
      return this.deadLetter(
        message,
        certificateId,
        'certificate_not_found',
        'Unknown certificate',
      );
    }
    // Idempotency: a redelivered message must never generate the PDF a second time.
    if (certificate.isCompleted) {
      this.broker.ack(message);
      this.logger.info({ certificateId }, 'Duplicate delivery of a completed certificate ignored');
      return { kind: 'duplicate', certificateId };
    }

    const processing = certificate.markAsProcessing(this.clock.now());
    if (!processing.success) {
      // dead_letter: reprocessing must go through the DLQ endpoint, which resets the budget.
      return this.deadLetter(message, certificateId, 'invalid_state', processing.error.message);
    }
    await this.repository.save(processing.data);

    const generated = await this.pdfGenerator.generate(toPdfGenerationData(processing.data));
    if (!generated.success) {
      if (!generated.error.attempted) {
        // The breaker rejected the call without touching the API: roll the attempt back.
        await this.repository.save(certificate);
        return this.defer(certificateId, message, 'circuit_open');
      }
      return this.handleFailedAttempt(processing.data, generated.error, message);
    }

    const completed = processing.data.markAsCompleted(generated.data, this.clock.now());
    if (!completed.success) {
      const invalid = new PdfGenerationError('invalid_response', completed.error.message);
      return this.handleFailedAttempt(processing.data, invalid, message);
    }
    await this.repository.save(completed.data);
    this.broker.ack(message);
    this.logger.info(
      { certificateId, attempts: completed.data.attempts, pdfUrl: generated.data },
      'Certificate generated',
    );
    return {
      kind: 'completed',
      certificateId,
      pdfUrl: generated.data,
      attempts: completed.data.attempts,
    };
  }

  private async handleFailedAttempt(
    processing: Certificate,
    error: PdfGenerationError,
    message: ConsumedMessage,
  ): Promise<GenerateCertificateOutcome> {
    const certificateId = processing.id;
    const failed = unwrap(processing.markAsFailed(error.message, this.clock.now()));
    const decision = this.retryStrategy.nextRetry(failed);

    if (error.retryable && decision.success) {
      const { retryNumber, delayMs } = decision.data;
      await this.repository.save(failed);
      await this.broker.publish(retryQueueName(delayMs), message.content, {
        messageId: certificateId,
        headers: {
          [MESSAGE_HEADERS.retryNumber]: retryNumber,
          [MESSAGE_HEADERS.deferrals]: readCounter(message.headers, MESSAGE_HEADERS.deferrals),
        },
      });
      this.broker.ack(message);
      this.logger.warn(
        { certificateId, attempts: failed.attempts, retryNumber, delayMs, kind: error.kind },
        'PDF generation failed, retry scheduled',
      );
      return {
        kind: 'retry_scheduled',
        certificateId,
        attempts: failed.attempts,
        retryNumber,
        delayMs,
        error: error.message,
      };
    }

    const reason: DeadLetterReason = error.retryable
      ? 'max_retries_exceeded'
      : 'non_retryable_error';
    const cause = decision.success ? error.message : `${decision.error.message} (${error.message})`;
    const dead = unwrap(failed.markAsDeadLetter(cause, this.clock.now()));
    await this.repository.save(dead);
    return this.deadLetter(message, certificateId, reason, cause);
  }

  /** Parks a message that could not be attempted, without spending its retry budget. */
  private async defer(
    certificateId: string,
    message: ConsumedMessage,
    reason: DeferralReason,
  ): Promise<GenerateCertificateOutcome> {
    const deferrals = readCounter(message.headers, MESSAGE_HEADERS.deferrals) + 1;
    if (deferrals > this.options.maxDeferrals) {
      const cause = `Deferred ${this.options.maxDeferrals} times (${reason}): giving up`;
      await this.tryMarkAsDeadLetter(certificateId, cause);
      return this.deadLetter(message, certificateId, 'max_deferrals_exceeded', cause);
    }

    const delayMs = this.options.deferDelayMs;
    await this.broker.publish(retryQueueName(delayMs), message.content, {
      messageId: certificateId,
      headers: {
        [MESSAGE_HEADERS.deferrals]: deferrals,
        [MESSAGE_HEADERS.retryNumber]: readCounter(message.headers, MESSAGE_HEADERS.retryNumber),
      },
    });
    this.broker.ack(message);
    this.logger.debug({ certificateId, reason, deferrals, delayMs }, 'Certificate deferred');
    return { kind: 'deferred', certificateId, reason, delayMs, deferrals };
  }

  private deadLetter(
    message: ConsumedMessage,
    certificateId: string,
    reason: DeadLetterReason,
    error: string,
  ): GenerateCertificateOutcome {
    // The main queue declares x-dead-letter-exchange: RabbitMQ moves the message atomically.
    this.broker.nack(message, false);
    this.logger.error(
      { certificateId, reason, error },
      'Certificate sent to the Dead Letter Queue',
    );
    return { kind: 'dead_lettered', certificateId, reason, error };
  }

  private async deferAfterInfrastructureFailure(
    certificateId: string,
    message: ConsumedMessage,
    error: unknown,
  ): Promise<Result<GenerateCertificateOutcome, UnexpectedError>> {
    this.logger.error(
      { certificateId, err: error },
      'Infrastructure failure while processing a certificate',
    );
    try {
      return ok(await this.defer(certificateId, message, 'infrastructure_error'));
    } catch (deferError: unknown) {
      // Not even the broker accepts the message: give it back, RabbitMQ will redeliver it.
      this.broker.nack(message, true);
      this.logger.error(
        { certificateId, err: deferError },
        'Could not defer the message, requeued it instead',
      );
      return fail(new UnexpectedError('Processing the certificate', error));
    }
  }

  private async tryMarkAsDeadLetter(certificateId: string, reason: string): Promise<void> {
    try {
      const certificate = await this.repository.findById(certificateId);
      const dead = certificate?.markAsDeadLetter(reason, this.clock.now());
      if (dead?.success) {
        await this.repository.save(dead.data);
      }
    } catch (error: unknown) {
      this.logger.warn(
        { certificateId, err: errorMessage(error) },
        'Could not record the dead-letter status (the message is still dead-lettered)',
      );
    }
  }
}
