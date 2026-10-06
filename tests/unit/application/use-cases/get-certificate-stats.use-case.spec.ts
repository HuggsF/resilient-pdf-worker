import { UnexpectedError } from '@application/errors/unexpected.error';
import { GetCertificateStatsUseCase } from '@application/use-cases/get-certificate-stats.use-case';
import {
  FakeMessageBroker,
  InMemoryCertificateRepository,
  aCertificate,
  createLoggerMock,
  inState,
  jobMessage,
} from '../../../support/fakes';
import type { LoggerMock } from '../../../support/fakes';

const RETRY_QUEUES = ['certificate.retry.1s', 'certificate.retry.4s'];

type Setup = {
  readonly repository: InMemoryCertificateRepository;
  readonly broker: FakeMessageBroker;
  readonly logger: LoggerMock;
  readonly useCase: GetCertificateStatsUseCase;
};

const setup = (): Setup => {
  const repository = new InMemoryCertificateRepository();
  const broker = new FakeMessageBroker();
  const logger = createLoggerMock();
  const useCase = new GetCertificateStatsUseCase(repository, broker, RETRY_QUEUES, logger);
  return { repository, broker, logger, useCase };
};

describe('GetCertificateStatsUseCase', () => {
  it('counts certificates per status and messages per queue', async () => {
    const { useCase, repository, broker } = setup();
    repository.seed(
      aCertificate({ id: 'a' }),
      inState(aCertificate({ id: 'b' }), 'processing', 'completed'),
      inState(aCertificate({ id: 'c' }), 'processing', 'completed'),
      inState(aCertificate({ id: 'd' }), 'dead_letter'),
    );
    broker.enqueue('certificate.generate', jobMessage('a'));
    broker.enqueue('certificate.retry.1s', jobMessage('x'), jobMessage('y'));
    broker.enqueue('certificate.retry.4s', jobMessage('z'));
    broker.enqueue('certificate.dlq', jobMessage('d'));

    const result = await useCase.execute();

    expect(result).toEqual({
      success: true,
      data: {
        total: 4,
        byStatus: { pending: 1, processing: 0, completed: 2, failed: 0, dead_letter: 1 },
        queues: { generate: 1, retry: 3, deadLetter: 1 },
      },
    });
  });

  it('still answers with the database counts when RabbitMQ is unreachable', async () => {
    const { useCase, broker, logger } = setup();
    broker.countError = new Error('channel closed');

    const result = await useCase.execute();

    expect(result.success && result.data.queues).toBeNull();
    expect(result.success && result.data.total).toBe(0);
    expect(logger.warn.mock.calls.map(([, message]) => message)).toEqual([
      'Queue depths unavailable',
    ]);
  });

  it('fails when the database is unreachable', async () => {
    const { useCase, repository } = setup();
    repository.failOn('countByStatus');

    const result = await useCase.execute();

    expect(!result.success && result.error).toBeInstanceOf(UnexpectedError);
  });
});
