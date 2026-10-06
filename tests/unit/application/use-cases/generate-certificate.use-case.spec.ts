import type { GenerateCertificateOutcome } from '@application/dtos/generate-certificate.dto';
import { UnexpectedError } from '@application/errors/unexpected.error';
import { encodeCertificateJob } from '@application/services/certificate-job.codec';
import { GenerateCertificateUseCase } from '@application/use-cases/generate-certificate.use-case';
import { RetryStrategy } from '@domain/services/retry-strategy';
import type { Certificate } from '@domain/entities/certificate.entity';
import {
  CERTIFICATE_ID,
  FakeMessageBroker,
  FixedClock,
  InMemoryCertificateRepository,
  ScriptedPdfGenerator,
  Timeline,
  aCertificate,
  createLoggerMock,
  inState,
  jobMessage,
  rawMessage,
} from '../../../support/fakes';
import type { LoggerMock } from '../../../support/fakes';

const PDF_URL = `https://cdn.example.edu/certificates/${CERTIFICATE_ID}.pdf`;
const DEFER_DELAY_MS = 30_000;
const MAX_DEFERRALS = 3;

const retryStrategy = (): RetryStrategy => {
  const result = RetryStrategy.create();
  if (!result.success) throw result.error;
  return result.data;
};

type Setup = {
  readonly timeline: Timeline;
  readonly repository: InMemoryCertificateRepository;
  readonly broker: FakeMessageBroker;
  readonly logger: LoggerMock;
  readonly useCase: GenerateCertificateUseCase;
  readonly pdf: ScriptedPdfGenerator;
  readonly stored: () => Certificate;
};

const setup = (pdf: ScriptedPdfGenerator, ...seed: Certificate[]): Setup => {
  const timeline = new Timeline();
  const repository = new InMemoryCertificateRepository(timeline);
  const broker = new FakeMessageBroker(timeline);
  const logger = createLoggerMock();
  repository.seed(...seed);
  const useCase = new GenerateCertificateUseCase(
    repository,
    pdf,
    broker,
    retryStrategy(),
    new FixedClock(),
    logger,
    { deferDelayMs: DEFER_DELAY_MS, maxDeferrals: MAX_DEFERRALS },
  );
  const stored = (): Certificate => repository.certificates.get(CERTIFICATE_ID)!;
  return { timeline, repository, broker, logger, useCase, pdf, stored };
};

const outcomeOf = (
  result: Awaited<ReturnType<GenerateCertificateUseCase['execute']>>,
): GenerateCertificateOutcome => {
  if (!result.success) throw result.error;
  return result.data;
};

/** A certificate that already failed `attempts` times. */
const failedTimes = (attempts: number): Certificate => {
  let certificate = aCertificate();
  for (let i = 0; i < attempts; i += 1) certificate = inState(certificate, 'processing', 'failed');
  return certificate;
};

describe('GenerateCertificateUseCase', () => {
  describe('happy path', () => {
    it('generates the PDF, persists "completed" and only THEN acks the message', async () => {
      const { useCase, broker, timeline, stored, pdf } = setup(
        new ScriptedPdfGenerator(PDF_URL),
        aCertificate(),
      );
      const message = jobMessage();

      const outcome = outcomeOf(await useCase.execute({ message }));

      expect(outcome).toEqual({
        kind: 'completed',
        certificateId: CERTIFICATE_ID,
        pdfUrl: PDF_URL,
        attempts: 1,
      });
      expect(timeline.entries).toEqual(['save:processing:1', 'save:completed:1', 'ack']);
      expect(broker.acked).toEqual([message]);
      expect(broker.nacked).toEqual([]);
      expect(stored()).toMatchObject({ status: 'completed', pdfUrl: PDF_URL, attempts: 1 });
      expect(pdf.calls).toEqual([
        {
          certificateId: CERTIFICATE_ID,
          studentId: 'student-42',
          studentName: 'Ana Souza',
          courseName: 'Node.js Advanced',
          completionDate: '2026-02-20',
        },
      ]);
    });

    it('is idempotent: a redelivered message of a completed certificate is acked without a new PDF', async () => {
      const completed = inState(aCertificate(), 'processing', 'completed');
      const { useCase, broker, pdf, timeline } = setup(new ScriptedPdfGenerator(), completed);

      const outcome = outcomeOf(
        await useCase.execute({ message: jobMessage(CERTIFICATE_ID, {}, true) }),
      );

      expect(outcome).toEqual({ kind: 'duplicate', certificateId: CERTIFICATE_ID });
      expect(pdf.calls).toHaveLength(0);
      expect(broker.acked).toHaveLength(1);
      expect(timeline.entries).toEqual(['ack']);
    });
  });

  describe('PDF API failure → retry with exponential backoff', () => {
    it('persists "failed", publishes a confirmed copy to the 1s retry queue, then acks', async () => {
      const { useCase, broker, timeline, stored } = setup(
        new ScriptedPdfGenerator('server_error'),
        aCertificate(),
      );
      const message = jobMessage();

      const outcome = outcomeOf(await useCase.execute({ message }));

      expect(outcome).toEqual({
        kind: 'retry_scheduled',
        certificateId: CERTIFICATE_ID,
        attempts: 1,
        retryNumber: 1,
        delayMs: 1000,
        error: 'PDF API failure: server_error',
      });
      expect(timeline.entries).toEqual([
        'save:processing:1',
        'save:failed:1',
        'publish:certificate.retry.1s',
        'ack',
      ]);
      expect(broker.published[0]).toEqual({
        queue: 'certificate.retry.1s',
        content: message.content,
        options: {
          messageId: CERTIFICATE_ID,
          headers: { 'x-retry-number': 1, 'x-deferrals': 0 },
        },
      });
      expect(stored()).toMatchObject({
        status: 'failed',
        attempts: 1,
        lastError: 'PDF API failure: server_error',
      });
    });

    it('walks 1s → 4s → 16s and dead-letters the message after the 4th failed attempt', async () => {
      const { useCase, broker, pdf, stored } = setup(
        new ScriptedPdfGenerator('server_error'),
        aCertificate(),
      );

      const outcomes: GenerateCertificateOutcome[] = [];
      for (let delivery = 0; delivery < 4; delivery += 1) {
        outcomes.push(outcomeOf(await useCase.execute({ message: jobMessage() })));
      }

      expect(outcomes.map((outcome) => outcome.kind)).toEqual([
        'retry_scheduled',
        'retry_scheduled',
        'retry_scheduled',
        'dead_lettered',
      ]);
      expect(broker.published.map(({ queue }) => queue)).toEqual([
        'certificate.retry.1s',
        'certificate.retry.4s',
        'certificate.retry.16s',
      ]);
      expect(pdf.calls).toHaveLength(4);
      expect(broker.acked).toHaveLength(3);
      expect(broker.nacked.map(({ requeue }) => requeue)).toEqual([false]);
      expect(outcomes[3]).toMatchObject({ reason: 'max_retries_exceeded' });
      expect(stored()).toMatchObject({ status: 'dead_letter', attempts: 4 });
      expect(stored().lastError).toContain('failed 4 of 4 allowed attempts');
    });

    it('persists "dead_letter" BEFORE nacking without requeue (→ certificate.dlq)', async () => {
      const { useCase, timeline, logger } = setup(
        new ScriptedPdfGenerator('timeout'),
        failedTimes(3),
      );

      const outcome = outcomeOf(await useCase.execute({ message: jobMessage() }));

      expect(outcome).toMatchObject({ kind: 'dead_lettered', reason: 'max_retries_exceeded' });
      expect(timeline.entries).toEqual(['save:processing:4', 'save:dead_letter:4', 'nack:false']);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'max_retries_exceeded' }),
        'Certificate sent to the Dead Letter Queue',
      );
    });

    it('does not retry a request the API rejected (4xx): straight to the DLQ', async () => {
      const { useCase, broker, stored } = setup(
        new ScriptedPdfGenerator('rejected'),
        aCertificate(),
      );

      const outcome = outcomeOf(await useCase.execute({ message: jobMessage() }));

      expect(outcome).toMatchObject({ kind: 'dead_lettered', reason: 'non_retryable_error' });
      expect(broker.published).toHaveLength(0);
      expect(stored()).toMatchObject({ status: 'dead_letter', attempts: 1 });
      expect(stored().lastError).toBe('PDF API failure: rejected');
    });

    it('treats an unusable PDF URL from the API as a failed attempt', async () => {
      const { useCase, stored } = setup(
        new ScriptedPdfGenerator('http://not a url'),
        aCertificate(),
      );

      const outcome = outcomeOf(await useCase.execute({ message: jobMessage() }));

      expect(outcome).toMatchObject({ kind: 'retry_scheduled', retryNumber: 1 });
      expect(stored().status).toBe('failed');
    });

    it('keeps the deferral counter of the message when scheduling a retry', async () => {
      const { useCase, broker } = setup(new ScriptedPdfGenerator('network'), aCertificate());

      await useCase.execute({ message: jobMessage(CERTIFICATE_ID, { 'x-deferrals': 2 }) });

      expect(broker.published[0]?.options?.headers).toEqual({
        'x-retry-number': 1,
        'x-deferrals': 2,
      });
    });
  });

  describe('circuit breaker open', () => {
    it('does NOT count an attempt: rolls the status back and parks the message', async () => {
      const failedOnce = failedTimes(1);
      const { useCase, broker, timeline, stored } = setup(
        new ScriptedPdfGenerator('circuit_open'),
        failedOnce,
      );

      const outcome = outcomeOf(await useCase.execute({ message: jobMessage() }));

      expect(outcome).toEqual({
        kind: 'deferred',
        certificateId: CERTIFICATE_ID,
        reason: 'circuit_open',
        delayMs: DEFER_DELAY_MS,
        deferrals: 1,
      });
      expect(timeline.entries).toEqual([
        'save:processing:2',
        'save:failed:1',
        'publish:certificate.retry.30s',
        'ack',
      ]);
      expect(stored()).toBe(failedOnce);
      expect(broker.published[0]?.options?.headers).toEqual({
        'x-deferrals': 1,
        'x-retry-number': 0,
      });
    });

    it('bounds parking: after maxDeferrals the message goes to the DLQ', async () => {
      const { useCase, broker, stored } = setup(
        new ScriptedPdfGenerator('circuit_open'),
        aCertificate(),
      );

      const outcome = outcomeOf(
        await useCase.execute({
          message: jobMessage(CERTIFICATE_ID, { 'x-deferrals': MAX_DEFERRALS }),
        }),
      );

      expect(outcome).toMatchObject({ kind: 'dead_lettered', reason: 'max_deferrals_exceeded' });
      expect(broker.published).toHaveLength(0);
      expect(broker.nacked.map(({ requeue }) => requeue)).toEqual([false]);
      expect(stored()).toMatchObject({ status: 'dead_letter', attempts: 0 });
    });

    it('still dead-letters the message when the status cannot be recorded', async () => {
      const { useCase, broker, repository, logger } = setup(
        new ScriptedPdfGenerator('circuit_open'),
        aCertificate(),
      );
      const save = repository.save.bind(repository);
      let saves = 0;
      jest.spyOn(repository, 'save').mockImplementation(async (certificate) => {
        saves += 1;
        if (saves > 2) throw new Error('database down');
        await save(certificate);
      });

      const outcome = outcomeOf(
        await useCase.execute({ message: jobMessage(CERTIFICATE_ID, { 'x-deferrals': '9' }) }),
      );

      expect(outcome).toMatchObject({ kind: 'dead_lettered', reason: 'max_deferrals_exceeded' });
      expect(broker.nacked).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ certificateId: CERTIFICATE_ID }),
        expect.stringContaining('Could not record the dead-letter status'),
      );
    });
  });

  describe('messages that cannot be processed', () => {
    it.each(['not json', '[]', '{"version":1}', '{"version":2,"certificateId":"x"}'])(
      'dead-letters a poison message %p',
      async (body) => {
        const { useCase, broker, pdf } = setup(new ScriptedPdfGenerator());

        const outcome = outcomeOf(await useCase.execute({ message: rawMessage(body) }));

        expect(outcome).toMatchObject({
          kind: 'dead_lettered',
          certificateId: null,
          reason: 'invalid_message',
        });
        expect(broker.nacked.map(({ requeue }) => requeue)).toEqual([false]);
        expect(pdf.calls).toHaveLength(0);
      },
    );

    it('dead-letters a message for an unknown certificate', async () => {
      const { useCase, broker } = setup(new ScriptedPdfGenerator());

      const outcome = outcomeOf(await useCase.execute({ message: jobMessage('missing-id') }));

      expect(outcome).toMatchObject({ kind: 'dead_lettered', reason: 'certificate_not_found' });
      expect(broker.nacked[0]?.requeue).toBe(false);
    });

    it('sends a message of a dead-lettered certificate back to the DLQ (reprocess via the API)', async () => {
      const { useCase, broker, pdf } = setup(
        new ScriptedPdfGenerator(),
        inState(aCertificate(), 'dead_letter'),
      );

      const outcome = outcomeOf(await useCase.execute({ message: jobMessage() }));

      expect(outcome).toMatchObject({ kind: 'dead_lettered', reason: 'invalid_state' });
      expect(broker.nacked[0]?.requeue).toBe(false);
      expect(pdf.calls).toHaveLength(0);
    });
  });

  describe('infrastructure failures', () => {
    it('parks the message when the database is down (no attempt, no ack before the copy is confirmed)', async () => {
      const { useCase, repository, broker, pdf, timeline } = setup(
        new ScriptedPdfGenerator(),
        aCertificate(),
      );
      repository.failOn('findById');

      const outcome = outcomeOf(await useCase.execute({ message: jobMessage() }));

      expect(outcome).toMatchObject({ kind: 'deferred', reason: 'infrastructure_error' });
      expect(pdf.calls).toHaveLength(0);
      expect(timeline.entries).toEqual(['publish:certificate.retry.30s', 'ack']);
      expect(broker.nacked).toHaveLength(0);
    });

    it('parks the message when the "completed" status cannot be persisted', async () => {
      const { useCase, repository, broker } = setup(
        new ScriptedPdfGenerator(PDF_URL),
        aCertificate(),
      );
      const save = repository.save.bind(repository);
      jest.spyOn(repository, 'save').mockImplementation(async (certificate) => {
        if (certificate.status === 'completed') throw new Error('database down');
        await save(certificate);
      });

      const outcome = outcomeOf(await useCase.execute({ message: jobMessage() }));

      expect(outcome).toMatchObject({ kind: 'deferred', reason: 'infrastructure_error' });
      expect(broker.acked).toHaveLength(1);
      expect(broker.published.map(({ queue }) => queue)).toEqual(['certificate.retry.30s']);
    });

    it('requeues the message when neither the database nor the broker accept it', async () => {
      const { useCase, repository, broker } = setup(new ScriptedPdfGenerator(), aCertificate());
      repository.failOn('findById');
      broker.publishError = new Error('channel closed');

      const result = await useCase.execute({ message: jobMessage() });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(UnexpectedError);
        expect(result.error.message).toContain('database down');
      }
      expect(broker.acked).toHaveLength(0);
      expect(broker.nacked.map(({ requeue }) => requeue)).toEqual([true]);
    });

    it('requeues (never acks) when the retry copy cannot be published', async () => {
      const { useCase, broker, stored } = setup(
        new ScriptedPdfGenerator('server_error'),
        aCertificate(),
      );
      broker.publishError = new Error('channel closed');

      const result = await useCase.execute({ message: jobMessage() });

      expect(result.success).toBe(false);
      expect(broker.acked).toHaveLength(0);
      expect(broker.nacked.map(({ requeue }) => requeue)).toEqual([true]);
      // The attempt happened and is recorded: the redelivery will be attempt #2.
      expect(stored()).toMatchObject({ status: 'failed', attempts: 1 });
    });
  });

  it('accepts the job encoder output', () => {
    expect(JSON.parse(encodeCertificateJob({ certificateId: 'abc' }).toString())).toEqual({
      version: 1,
      certificateId: 'abc',
    });
  });
});
