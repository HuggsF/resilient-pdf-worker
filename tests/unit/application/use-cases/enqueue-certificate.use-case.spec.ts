import { QueueUnavailableError } from '@application/errors/queue-unavailable.error';
import { UnexpectedError } from '@application/errors/unexpected.error';
import { decodeCertificateJob } from '@application/services/certificate-job.codec';
import { EnqueueCertificateUseCase } from '@application/use-cases/enqueue-certificate.use-case';
import { InvalidCertificateError } from '@domain/errors/invalid-certificate.error';
import {
  FakeMessageBroker,
  FixedClock,
  InMemoryCertificateRepository,
  SequentialIdGenerator,
  Timeline,
  createLoggerMock,
} from '../../../support/fakes';
import type { LoggerMock } from '../../../support/fakes';

const ID = '0192f1a4-0000-7000-8000-000000000001';

type Setup = {
  readonly repository: InMemoryCertificateRepository;
  readonly broker: FakeMessageBroker;
  readonly logger: LoggerMock;
  readonly useCase: EnqueueCertificateUseCase;
  readonly timeline: Timeline;
};

const setup = (): Setup => {
  const timeline = new Timeline();
  const repository = new InMemoryCertificateRepository(timeline);
  const broker = new FakeMessageBroker(timeline);
  const logger = createLoggerMock();
  const useCase = new EnqueueCertificateUseCase(
    repository,
    broker,
    new SequentialIdGenerator(),
    new FixedClock(new Date('2026-03-01T12:00:00.000Z')),
    logger,
  );
  return { repository, broker, logger, useCase, timeline };
};

const input = {
  studentId: 'student-42',
  studentName: 'Ana Souza',
  courseName: 'Node.js Advanced',
  completionDate: '2026-02-20',
};

describe('EnqueueCertificateUseCase', () => {
  it('saves a pending certificate, then publishes a claim-check job to certificate.generate', async () => {
    const { useCase, repository, broker, timeline } = setup();

    const result = await useCase.execute(input);

    expect(result).toEqual({ success: true, data: { certificateId: ID, status: 'pending' } });
    expect(timeline.entries).toEqual(['save:pending:0', 'publish:certificate.generate']);
    expect(repository.certificates.get(ID)?.toSnapshot()).toMatchObject({
      ...input,
      status: 'pending',
      attempts: 0,
    });
    const [published] = broker.published;
    expect(published?.queue).toBe('certificate.generate');
    expect(published?.options).toEqual({ messageId: ID });
    expect(decodeCertificateJob(published!.content)).toEqual({
      success: true,
      data: { certificateId: ID },
    });
  });

  it('defaults the completion date to today (UTC)', async () => {
    const { useCase, repository } = setup();

    await useCase.execute({ ...input, completionDate: undefined });

    expect(repository.certificates.get(ID)?.completionDate.value).toBe('2026-03-01');
  });

  it('rejects an invalid request without touching the database or the queue', async () => {
    const { useCase, timeline } = setup();

    const result = await useCase.execute({ ...input, studentName: 'A', courseName: '' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(InvalidCertificateError);
    }
    expect(timeline.entries).toEqual([]);
  });

  it('does not publish when the certificate cannot be saved', async () => {
    const { useCase, repository, broker } = setup();
    repository.failOn('save');

    const result = await useCase.execute(input);

    expect(!result.success && result.error).toBeInstanceOf(UnexpectedError);
    expect(broker.published).toHaveLength(0);
  });

  it('answers QueueUnavailable when RabbitMQ does not confirm the message', async () => {
    const { useCase, broker, repository, logger } = setup();
    broker.publishError = new Error('connection closed');

    const result = await useCase.execute(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(QueueUnavailableError);
      expect(result.error.code).toBe('QUEUE_UNAVAILABLE');
    }
    expect(repository.certificates.get(ID)?.status).toBe('pending');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ certificateId: ID }),
      'Certificate saved but its job could not be published',
    );
  });
});
